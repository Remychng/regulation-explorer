#!/usr/bin/env python3
"""Refresh in-force regulations and rebuild all derived RegBro data.

EUR-Lex acts are discovered from their ``authId`` in ``data/index.json``.
Other sources can opt in with an ``update`` object containing ``url`` and
``parser`` (``consolidated``, ``consolidated_lists``, ``oj``, ``oj_lists``,
``boersengesetz``, or ``nis2_bsig``).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from urllib.parse import urlencode, urlparse
from functools import wraps
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Callable, Iterable

APP = Path(__file__).resolve().parent.parent
INDEX_PATH = APP / "data" / "index.json"
LOG_PATH = APP / "logs" / "update_regulations.log"
LOG_MAX_BYTES = 100 * 1024 * 1024
PARSERS_DIR = APP / "tools" / "parsers"
IN_FORCE = "In Force"
CELLAR_CELEX_PREFIX = "https://publications.europa.eu/resource/celex/"
CELLAR_SPARQL_URL = "https://publications.europa.eu/webapi/rdf/sparql"
CELLAR_DOWNLOAD_URL = "https://op.europa.eu/o/opportal-service/download-handler"
Fetch = Callable[[str, int], bytes]
LOGGER = logging.getLogger("regulation_updater")


def configure_logging(log_path: Path = LOG_PATH) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        log_path, maxBytes=LOG_MAX_BYTES, backupCount=5, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    for existing_handler in LOGGER.handlers:
        existing_handler.close()
    LOGGER.handlers.clear()
    LOGGER.addHandler(handler)
    LOGGER.setLevel(logging.DEBUG)
    LOGGER.propagate = False
    LOGGER.debug("Completed configure_logging")


def logged(function):
    @wraps(function)
    def wrapper(*args, **kwargs):
        LOGGER.debug("Starting %s", function.__name__)
        try:
            result = function(*args, **kwargs)
        except Exception:
            LOGGER.exception("Failed %s", function.__name__)
            raise
        LOGGER.debug("Completed %s", function.__name__)
        return result

    return wrapper


@logged
def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@logged
def read_json(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


@logged
def write_json(path: Path, payload) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def request_bytes(url: str, timeout: int, accept: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": accept,
            "User-Agent": "RegBro regulation updater/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def cellar_download_url(work_uri: str) -> str:
    identifier = urlparse(work_uri).path.rstrip("/").rsplit("/", 1)[-1]
    if not identifier:
        raise ValueError("CELLAR returned a work without an identifier")
    return f"{CELLAR_DOWNLOAD_URL}?{urlencode({
        'identifier': identifier,
        'format': 'HTML',
        'language': 'en',
        'productionSystem': 'cellar',
        'part': '',
    })}"


def fetch_cellar(url: str, timeout: int) -> bytes:
    celex = url.removeprefix(CELLAR_CELEX_PREFIX)
    if celex.startswith("0"):
        condition = f'STRSTARTS(STR(?celex), "{celex}-")'
    else:
        condition = f'STR(?celex) = "{celex}"'
    query = (
        "PREFIX cdm: <http://publications.europa.eu/ontology/cdm#> "
        "SELECT ?work ?celex WHERE { "
        "?work cdm:resource_legal_id_celex ?celex . "
        f"FILTER({condition}) }} ORDER BY DESC(?celex) LIMIT 1"
    )
    search_url = f"{CELLAR_SPARQL_URL}?{urlencode({'query': query})}"
    payload = json.loads(
        request_bytes(search_url, timeout, "application/sparql-results+json")
    )
    bindings = payload.get("results", {}).get("bindings", [])
    if not bindings:
        raise ValueError(f"CELLAR has no English work for CELEX:{celex}")
    work_uri = bindings[0].get("work", {}).get("value", "")
    return request_bytes(
        cellar_download_url(work_uri), timeout, "application/xhtml+xml,text/html"
    )


@logged
def fetch_url(url: str, timeout: int) -> bytes:
    if url.startswith(CELLAR_CELEX_PREFIX):
        return fetch_cellar(url, timeout)
    return request_bytes(
        url, timeout, "text/html,application/xhtml+xml,application/pdf"
    )


@logged
def celex_from_entry(entry: dict) -> str | None:
    auth_id = entry.get("authId")
    if not isinstance(auth_id, str) or not auth_id.lower().startswith("celex:"):
        return None
    value = auth_id.split(":", 1)[1].strip().upper()
    return value or None


@logged
def eurlex_urls(celex: str) -> list[str]:
    identifiers = [celex]
    if celex.startswith("3"):
        identifiers.insert(0, f"0{celex[1:]}")
    cellar_urls = [f"{CELLAR_CELEX_PREFIX}{identifier}" for identifier in identifiers]
    eurlex_fallbacks = [
        f"https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:{identifier}"
        for identifier in identifiers
    ]
    return cellar_urls + eurlex_fallbacks


@logged
def update_config(entry: dict) -> tuple[list[str], str, str]:
    config = entry.get("update")
    if config is False or (isinstance(config, dict) and config.get("enabled") is False):
        return [], "auto", "utf-8"
    config = config if isinstance(config, dict) else {}
    configured_urls = config.get("url")
    if isinstance(configured_urls, str):
        urls = [configured_urls]
    elif isinstance(configured_urls, list):
        urls = [url for url in configured_urls if isinstance(url, str) and url]
    else:
        celex = celex_from_entry(entry)
        urls = eurlex_urls(celex) if celex else []
    return urls, config.get("parser", "auto"), config.get("encoding", "utf-8")


@logged
def decode_html(content: bytes, encoding: str) -> str:
    declaration = re.search(
        br"<\?xml\b[^>]*\bencoding=[\"']([A-Za-z0-9._-]+)[\"']",
        content[:256],
        re.I,
    )
    if declaration:
        encoding = declaration.group(1).decode("ascii")
    try:
        return content.decode(encoding)
    except (LookupError, UnicodeDecodeError):
        return content.decode("utf-8", errors="replace")


@logged
def parse_articles(content: bytes, parser_name: str, encoding: str) -> list[dict]:
    if parser_name == "nis2_bsig":
        module = load_module("update_parser_nis2_bsig", PARSERS_DIR / "parser_nis2_bsig.py")
        descriptor, source_name = tempfile.mkstemp(suffix=".pdf")
        try:
            with os.fdopen(descriptor, "wb") as source:
                source.write(content)
            articles = module.parse(source_name)
        finally:
            Path(source_name).unlink(missing_ok=True)
    else:
        html = decode_html(content, encoding)
        parsers = {
            "consolidated": ("parser_consolidated.py", "update_parser_consolidated"),
            "consolidated_lists": (
                "parser_consolidated_lists.py",
                "update_parser_consolidated_lists",
            ),
            "oj": ("parser_oj.py", "update_parser_oj"),
            "oj_lists": ("parser_oj_lists.py", "update_parser_oj_lists"),
            "boersengesetz": ("parser_boersengesetz.py", "update_parser_boersengesetz"),
        }
        names = ("consolidated", "oj") if parser_name == "auto" else (parser_name,)
        articles = []
        for name in names:
            if name not in parsers:
                raise ValueError(f"unsupported parser: {name}")
            filename, module_name = parsers[name]
            module = load_module(module_name, PARSERS_DIR / filename)
            articles = module.parse(html)
            if articles:
                break

    if not isinstance(articles, list) or not articles:
        raise ValueError("parser produced no articles")
    article_ids = [article.get("id") for article in articles if isinstance(article, dict)]
    if len(article_ids) != len(articles) or any(not value for value in article_ids):
        raise ValueError("parser produced an article without an id")
    if len(article_ids) != len(set(article_ids)):
        raise ValueError("parser produced duplicate article ids")
    return articles


@logged
def linked_articles(articles: list[dict], act_id: str) -> list[dict]:
    linker = load_module("update_link_references", APP / "tools" / "link_references.py")
    self_ids = linker.self_article_ids(articles)
    for article in articles:
        for paragraph in article.get("paragraphs", []):
            text = paragraph.get("text", "")
            paragraph["text"] = linker.link_text(text, act_id, self_ids)
    return articles


@logged
def replace_articles(document, articles: list[dict]):
    if isinstance(document, list):
        return articles
    if not isinstance(document, dict):
        raise ValueError("act JSON must be an object or an article list")
    updated = dict(document)
    updated["articles"] = articles
    return updated


@logged
def selected_entries(index: dict, only: Iterable[str]) -> list[dict]:
    requested = set(only)
    selected = []
    for entry in index.get("acts", []):
        if entry.get("status", IN_FORCE) != IN_FORCE:
            continue
        if requested and entry.get("id") not in requested and entry.get("path") not in requested:
            continue
        selected.append(entry)
    return selected


@logged
def refresh_entry(entry: dict, fetcher: Fetch, timeout: int) -> tuple[str, object | None]:
    urls, parser_name, encoding = update_config(entry)
    if not urls:
        return "unsupported", None

    errors = []
    for url in urls:
        try:
            articles = parse_articles(fetcher(url, timeout), parser_name, encoding)
            articles = linked_articles(articles, entry["id"])
            path = APP / entry["path"]
            current = read_json(path)
            updated = replace_articles(current, articles)
            return ("unchanged" if updated == current else "updated"), updated
        except Exception as exc:  # Continue to a fallback source and then the next act.
            LOGGER.warning(
                "Source failed for %s: %s: %s",
                entry.get("id", "<unknown>"),
                url,
                exc,
            )
            errors.append(f"{url}: {exc}")
    raise RuntimeError("; ".join(errors))


@logged
def run_pipeline() -> None:
    LOGGER.info("Re-linking references")
    subprocess.run([sys.executable, str(APP / "tools" / "link_references.py")], check=True)
    LOGGER.info("Rebuilding indexes")
    subprocess.run([sys.executable, str(APP / "tools" / "build_index_db.py")], check=True)


@logged
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Refresh all in-force regulations, references, and indexes."
    )
    parser.add_argument("only", nargs="*", help="Optional act ids or registry paths")
    parser.add_argument("--check", action="store_true", help="Report updates without writing files")
    parser.add_argument("--timeout", type=int, default=30, help="Download timeout in seconds")
    parser.add_argument("--index", type=Path, default=INDEX_PATH, help="Registry path")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    LOGGER.debug("Starting main")
    args = parse_args(argv)
    index = read_json(args.index)
    entries = selected_entries(index, args.only)
    counts = {"updated": 0, "unchanged": 0, "unsupported": 0, "failed": 0}

    for entry in entries:
        try:
            result, payload = refresh_entry(entry, fetch_url, args.timeout)
            counts[result] += 1
            if result == "updated" and not args.check:
                write_json(APP / entry["path"], payload)
                LOGGER.info("Applied update to %s (%s)", entry["id"], entry["path"])
            else:
                LOGGER.info("%s: %s", entry["id"], result)
            print(f"{entry['id']}: {result}")
        except Exception as exc:
            counts["failed"] += 1
            LOGGER.exception("%s: failed", entry.get("id", "<unknown>"))
            print(f"{entry.get('id', '<unknown>')}: failed: {exc}", file=sys.stderr)

    summary = " ".join(f"{key}={value}" for key, value in counts.items())
    LOGGER.info(summary)
    print(summary)
    if counts["failed"]:
        LOGGER.debug("Completed main")
        return 1
    if args.check:
        LOGGER.debug("Completed main")
        return 2 if counts["updated"] else 0
    run_pipeline()
    LOGGER.debug("Completed main")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
