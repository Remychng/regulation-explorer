#!/usr/bin/env python3
"""Parse an EUR-Lex "Official Journal" (OJ) HTML into act-article JSON, one block per list point.

Variant of parser_oj.py: list points (table rows) become their own blocks, with nested
tables one level deeper (list-item-l1, list-item-l2). Titles may be "Article" or "Artikel".

Usage: python3 parser_oj_lists.py <input.html> [output.json]
"""
import copy
import json
import os
import re
import sys
import warnings

from bs4 import BeautifulSoup, Comment, NavigableString, Tag, XMLParsedAsHTMLWarning


def normalise_whitespace(value):
    return re.sub(r"\s+", " ", f"{value or ''}".replace("\u00A0", " ")).strip()


def escape_html(value):
    return (
        f"{value or ''}"
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def pad_number(value):
    return re.sub(r"\D", "", f"{value or ''}").zfill(4)


def build_eurlex_url_from_celex(celex_id):
    return f"https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:{celex_id}"


def build_directive_celex(year, number):
    return f"3{year}L{pad_number(number)}"


def build_regulation_celex(year, number):
    return f"3{year}R{pad_number(number)}"


def wrap_legal_link(display_text, celex_id, preview_label):
    href = build_eurlex_url_from_celex(celex_id)
    safe_preview = escape_html(f"{preview_label} \u2013 opens on EUR-Lex")
    return (
        f'<a href="{href}" class="legal-link" target="_blank" '
        f'rel="noopener noreferrer" data-preview="{safe_preview}">{display_text}</a>'
    )


def link_external_legal_references(text):
    output = text

    output = re.sub(
        r"\bDirective\s+(\d{4})/(\d{2,4})/(EU|EC)\b",
        lambda m: wrap_legal_link(
            m.group(0),
            build_directive_celex(m.group(1), m.group(2)),
            f"Directive {m.group(1)}/{m.group(2)}/{m.group(3)}",
        ),
        output,
    )

    output = re.sub(
        r"\bRegulation\s*\((EU|EC)\)\s*(?:No\s*)?(\d{1,4})/(\d{4})\b",
        lambda m: wrap_legal_link(
            m.group(0),
            build_regulation_celex(m.group(3), m.group(2)),
            f"Regulation ({m.group(1)}) {m.group(2)}/{m.group(3)}",
        ),
        output,
    )

    # Handle Decision No X/YYYY/EC format
    output = re.sub(
        r"\bDecision\s+No\s+(\d+)/(\d{4})/E[CU]\b",
        lambda m: wrap_legal_link(
            m.group(0), f"3{m.group(2)}D{pad_number(m.group(1))}", m.group(0)
        ),
        output,
    )

    return output


class OjParser:
    def __init__(self, soup):
        self.soup = soup
        self.article_number_to_id = {}

    def get_article_id_from_title(self, title_text, fallback_index):
        match = re.match(r"^Arti(?:cle|kel)\s+([0-9]+[a-z]?)", normalise_whitespace(title_text), re.I)
        if not match:
            return f"art_{fallback_index + 1}"
        return f"art_{match.group(1).lower()}"

    def register_article_number(self, title_text, article_id):
        match = re.match(r"^Arti(?:cle|kel)\s+([0-9]+[a-z]?)", normalise_whitespace(title_text), re.I)
        if not match or not article_id:
            return
        self.article_number_to_id[match.group(1).lower()] = article_id

    def build_internal_link(self, display_text, article_number_token):
        key = f"{article_number_token or ''}".lower()
        article_id = self.article_number_to_id.get(key)
        if not article_id:
            return escape_html(display_text)
        safe_text = escape_html(display_text)
        return (
            f'<a href="#{article_id}" class="internal-article-link" '
            f'target="_blank" rel="noopener">{safe_text}</a>'
        )

    def link_internal_article_references(self, text):
        if not text:
            return ""

        escaped = escape_html(text)

        def replace_article_list(value):
            return re.sub(
                r"\b[0-9]+[a-z]?\b",
                lambda m: self.build_internal_link(m.group(0), m.group(0)),
                value,
                flags=re.I,
            )

        def articles_repl(full_match):
            list_part = full_match.group(1)
            replaced_list = replace_article_list(list_part)
            return full_match.group(0).replace(list_part, replaced_list, 1)

        linked = re.sub(
            r"\bArticles\s+([0-9a-z\s,\-\u2013toandor]+)",
            articles_repl,
            escaped,
            flags=re.I,
        )

        def article_repl(full_match):
            article_number = full_match.group(1)
            return full_match.group(0).replace(
                article_number, self.build_internal_link(article_number, article_number), 1
            )

        linked = re.sub(
            r"\bArticle\s+([0-9]+[a-z]?)(\([0-9]+\))?",
            article_repl,
            linked,
            flags=re.I,
        )

        return link_external_legal_references(linked)


def class_of(node):
    if not isinstance(node, Tag):
        return ""
    cls = node.get("class")
    if not cls:
        return ""
    return " ".join(cls) if isinstance(cls, list) else str(cls)


BARE_LABEL = re.compile(r"[0-9a-zA-Z]{1,6}\)")


def block_text(node):
    clone = copy.copy(node)
    for modref in clone.select(".modref"):
        modref.decompose()
    return normalise_whitespace(clone.get_text())


def format_label(label):
    # OJ labels read "a)"; the app shows "(a)".
    label = normalise_whitespace(label)
    if BARE_LABEL.fullmatch(label):
        return f"({label[:-1]})"
    return label


def append_block(blocks, parts, depth):
    text = normalise_whitespace(" ".join(part for part in parts if part))
    if text:
        blocks.append((text, depth))


def table_blocks(table, depth):
    """One block per row; tables nested in a row's text cell are its deeper list items."""
    blocks = []
    for row in table.select(":scope > tbody > tr, :scope > tr"):
        cells = row.find_all("td", recursive=False)
        if len(cells) != 2:
            append_block(blocks, [block_text(row)], depth)
            continue
        pending = [format_label(block_text(cells[0]))]
        for child in cells[1].children:
            if not isinstance(child, Tag):
                continue
            if child.name == "table":
                append_block(blocks, pending, depth)
                pending = []
                blocks.extend(table_blocks(child, depth + 1))
            else:
                pending.append(block_text(child))
        append_block(blocks, pending, depth)
    return blocks


def node_blocks(node):
    """Return (text, depth) blocks for one element in an article body; depth 0 is a plain paragraph."""
    if node.name == "table":
        return table_blocks(node, 1)
    if node.name == "p" and re.search(
        r"\boj-normal\b|\beli-preamble-ind\b", class_of(node)
    ):
        text = block_text(node)
        return [(text, 0)] if text else []
    if node.name == "div" and not class_of(node):
        blocks, pending = [], []
        for child in node.children:
            if isinstance(child, Comment):
                continue
            if isinstance(child, NavigableString):
                pending.append(str(child))
            elif child.name in ("p", "table", "div"):
                append_block(blocks, ["".join(pending)], 0)
                pending = []
                blocks.extend(node_blocks(child))
            else:
                pending.append(child.get_text())
        append_block(blocks, ["".join(pending)], 0)
        return blocks
    return []


def parse(html):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", XMLParsedAsHTMLWarning)
        soup = BeautifulSoup(html, "lxml")
    parser = OjParser(soup)

    article_title_nodes = soup.select(
        'div.eli-subdivision[id^="art_"] > p.oj-ti-art'
    )
    articles = []

    # First pass: register article numbers
    for index, title_node in enumerate(article_title_nodes):
        title_text = normalise_whitespace(title_node.get_text())
        article_id = parser.get_article_id_from_title(title_text, index)
        parser.register_article_number(title_text, article_id)

    # Second pass: extract articles with their content
    for index, title_node in enumerate(article_title_nodes):
        title_text = normalise_whitespace(title_node.get_text())
        article_id = parser.get_article_id_from_title(title_text, index)

        heading = ""
        paragraphs = []
        paragraph_counter = 0

        next_article_node = (
            article_title_nodes[index + 1] if index + 1 < len(article_title_nodes) else None
        )

        for current in title_node.next_siblings:
            if current is next_article_node:
                break

            if isinstance(current, Tag):
                class_name = class_of(current)

                # Capture heading from eli-title div
                if not heading and re.search(r"\beli-title\b", class_name):
                    heading = normalise_whitespace(current.get_text())
                else:
                    for text, depth in node_blocks(current):
                        paragraph_counter += 1
                        paragraphs.append({
                            "id": f"{article_id}__{paragraph_counter}",
                            "text": parser.link_internal_article_references(text),
                            "class": "" if depth == 0 else f"list-item-l{depth}",
                        })

        if paragraphs:
            articles.append({
                "id": article_id,
                "title": title_text or article_id,
                "heading": heading,
                "paragraphs": paragraphs,
            })

    return articles


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 parser_oj.py <input.html> [output.json]", file=sys.stderr)
        sys.exit(1)

    input_file = sys.argv[1]
    if not os.path.exists(input_file):
        print(f"File not found: {input_file}", file=sys.stderr)
        sys.exit(1)

    output_file = sys.argv[2] if len(sys.argv) > 2 else re.sub(
        r"\.html$", ".json", input_file, flags=re.I
    )

    with open(input_file, encoding="utf-8") as fh:
        html = fh.read()

    articles = parse(html)

    with open(output_file, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(articles, ensure_ascii=False, indent=2) + "\n")

    print(f"Found {len(articles)} articles.")
    print(f"Wrote {len(articles)} articles to {output_file}")


if __name__ == "__main__":
    main()
