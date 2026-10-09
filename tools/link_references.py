#!/usr/bin/env python3
"""Cross-reference linker for the regulation browser.

Rewrites the reference links in every act JSON listed in ``data/index.json`` into
one unified anchor scheme:

    <a class="ref" data-celex="..." data-article="N" data-paragraph="..." href="...">…</a>

Grammar (resolved at runtime, see app.js):
  * ``data-celex`` present  -> cross-act reference; target act = that CELEX.
  * ``data-celex`` absent   -> same-act reference; target act = the current act.
  * ``data-article``        -> the referenced article number (optional).

The identifier stored in the data is always the permanent CELEX (derived purely
from the citation text). Whether a reference becomes an in-app jump or an EUR-Lex
link is decided at runtime by looking the CELEX up in the registry. The ``href``
is a no-JS fallback (EUR-Lex for cross-act, the in-app hash for same-act).

The pass is idempotent: it first unwraps any anchors it previously produced
(``ref``) as well as the legacy ``internal-article-link`` / ``legal-link``
anchors, then re-links from the plain text.
"""
import argparse
import json
import os
import re
import subprocess
import sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(APP, "data", "index.json")
EURLEX = "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:"


# --------------------------------------------------------------------------- #
# Identifier helpers
# --------------------------------------------------------------------------- #
def art_id_of(number):
    return "art_" + re.sub(r"[^0-9A-Za-z]+", "_", number).strip("_").lower()


def celex(letter, year, number):
    return f"3{year}{letter}{int(number):04d}"


# Citation grammar. A "group" is one leading word (Regulation/Directive, possibly
# plural) followed by one or more number specs, e.g.
#   "Regulation (EU) 2022/2554"
#   "Regulations (EU) No 1093/2010, (EU) No 1094/2010 and (EU) No 1095/2010"
KIND_RE = re.compile(r"\b(Regulations?|Directives?)", re.I)
WS_RE = re.compile(r"\s*")
SPEC_RE = re.compile(
    r"\((?:EU|EC|EEC)\)\s*No\s*(\d{1,4})/(\d{4})"      # (EU) No 648/2012  -> num/year
    r"|\((?:EU|EC|EEC)\)\s*(\d{4})/(\d{1,4})"          # (EU) 2022/2554    -> year/num
    r"|(\d{4})/(\d{1,4})/(?:EU|EC|EEC)"                # 2014/65/EU        -> year/num
)
SEP_RE = re.compile(r"\s*(?:,|and|or|\u2013|-)\s+", re.I)


def spec_celex(m, letter):
    if m.group(1):
        return celex(letter, m.group(2), m.group(1))
    if m.group(3):
        return celex(letter, m.group(3), m.group(4))
    return celex(letter, m.group(5), m.group(6))


# --------------------------------------------------------------------------- #
# Anchor builders
# --------------------------------------------------------------------------- #
def a_cross_article(cx, artnum, display):
    """Cross-act article reference: scheme-qualified id + article, EUR-Lex href."""
    return (
        f'<a href="{EURLEX}{cx}" class="ref" data-ref="celex:{cx}" '
        f'data-article="{artnum}" target="_blank" rel="noopener">{display}</a>'
    )


def a_cross_act(cx, display):
    """Cross-act act-level reference (no article): scheme-qualified id only."""
    return (
        f'<a href="{EURLEX}{cx}" class="ref" data-ref="celex:{cx}" '
        f'target="_blank" rel="noopener">{display}</a>'
    )


def a_self(act_id, artnum, display):
    """Same-act reference: no CELEX, real in-app hash as href."""
    return (
        f'<a href="#a:{act_id}:{art_id_of(artnum)}" class="ref" '
        f'data-article="{artnum}">{display}</a>'
    )


# --------------------------------------------------------------------------- #
# Unwrapping (idempotency) + anchor-safe substitution
# --------------------------------------------------------------------------- #
UNWRAP = re.compile(
    r'<(a|span)\b[^>]*class="[^"]*\b(?:ref|internal-article-link|legal-link|legal-reference)\b[^"]*"[^>]*>(.*?)</\1>',
    re.S,
)
ANCHOR = re.compile(r"<a\b[^>]*>.*?</a>", re.S)


def unwrap(text):
    prev = None
    while prev != text:  # handle any (defensive) nesting
        prev = text
        text = UNWRAP.sub(r"\2", text)
    return text


def outside_anchors(text, fn):
    """Apply ``fn`` only to the parts of ``text`` that are not inside an <a>."""
    out, i = [], 0
    for m in ANCHOR.finditer(text):
        out.append(fn(text[i:m.start()]))
        out.append(m.group(0))
        i = m.end()
    out.append(fn(text[i:]))
    return "".join(out)


# --------------------------------------------------------------------------- #
# Linking passes
# --------------------------------------------------------------------------- #
# "Article(s) 9, 10 and 11" — the article-number list preceding an " of <cite>".
ART_LIST = re.compile(
    r"\b(Articles?)\s+(\d+[a-z]?(?:\s*(?:,|and|or|to|\u2013|-)\s*\d+[a-z]?)*)",
    re.I,
)
NUM = re.compile(r"\d+[a-z]?")

# Filler that may sit between an article number and " of <act>": parenthetical
# paragraphs and point/paragraph/subparagraph clauses, e.g. "(2), point (a)".
BETWEEN = r"(?:\s*\([^)]*\)|\s*,|\s+(?:points?|paragraphs?|subparagraph|to|and))*"

# German section references: "§ 32", "§ 32 Absatz 1", "§§ 32, 33".
PARA = re.compile(r"\u00a7\u00a7?\s*\d+[a-z]?(?:\s*(?:,|und|bis|-)\s*\d+[a-z]?)*")
# Clauses that may follow a § number before naming another statute ("des ... Gesetzes").
DE_TAIL = r"(?:\s*(?:Absatz|Abs\.|Satz|Nummer|Nr\.)\s*\d+[a-z]?|\s*,)*"


def _link_list_cross(prefix, numlist, cx):
    if NUM.fullmatch(numlist.strip()):
        n = numlist.strip()
        return a_cross_article(cx, n, f"{prefix} {n}")
    linked = NUM.sub(lambda mm: a_cross_article(cx, mm.group(0), mm.group(0)), numlist)
    return f"{prefix} {linked}"


def _link_list_self(prefix, numlist, act_id, self_ids):
    def one(mm):
        n = mm.group(0)
        return a_self(act_id, n, n) if art_id_of(n) in self_ids else n
    if NUM.fullmatch(numlist.strip()):
        n = numlist.strip()
        return a_self(act_id, n, f"{prefix} {n}") if art_id_of(n) in self_ids else f"{prefix} {n}"
    return f"{prefix} {NUM.sub(one, numlist)}"


def render_citation_group(text, lead_start, lead_end):
    """Render a citation group starting at a Regulation(s)/Directive(s) word.

    Returns (rendered_html, end_index, first_celex) or None if no number spec
    follows the word (e.g. "this Regulation"). A single spec links the whole
    "<Word> (EU) num"; multiple specs keep the word plain and link each spec.
    """
    letter = "R" if text[lead_start:lead_end][:3].lower() == "reg" else "L"
    i = WS_RE.match(text, lead_end).end()
    m0 = SPEC_RE.match(text, i)
    if not m0:
        return None

    rest, end = [], m0.end()
    while True:
        sm = SEP_RE.match(text, end)
        if not sm:
            break
        nm = SPEC_RE.match(text, sm.end())
        if not nm:
            break
        rest.append((sm, nm))
        end = nm.end()

    first_cx = spec_celex(m0, letter)
    if not rest:
        return a_cross_act(first_cx, text[lead_start:end]), end, first_cx

    parts = [text[lead_start:m0.start()], a_cross_act(first_cx, m0.group(0))]
    for sm, nm in rest:
        parts.append(sm.group(0))
        parts.append(a_cross_act(spec_celex(nm, letter), nm.group(0)))
    return "".join(parts), end, first_cx


def pass_cross(text):
    """Article(s) N … of <citation group>  ->  cross-act article refs + act refs."""
    out, pos = [], 0
    m = ART_LIST.search(text, pos)
    while m:
        of = re.match(BETWEEN + r"\s+of\s+", text[m.end():])
        grp = None
        if of:
            km = KIND_RE.match(text, m.end() + of.end())
            if km:
                grp = render_citation_group(text, km.start(), km.end())
        if grp:
            rendered, gend, first_cx = grp
            out.append(text[pos:m.start()])
            out.append(_link_list_cross(m.group(1), m.group(2), first_cx))
            out.append(text[m.end():m.end() + of.end()])   # the " of " glue
            out.append(rendered)
            pos = gend
        else:
            out.append(text[pos:m.end()])
            pos = m.end()
        m = ART_LIST.search(text, pos)
    out.append(text[pos:])
    return "".join(out)


def make_pass_self(act_id, self_ids):
    # Same-act "Article N" not immediately followed by " of " (that would be a
    # reference into another instrument / the Treaties, handled or left alone).
    def pass_self(text):
        def repl(m):
            after = text[m.end():]
            mof = re.match(BETWEEN + r"\s+of\s+", after)
            # Skip when the article belongs to another instrument/the Treaties,
            # but keep self-links for "... of this Regulation/Directive".
            if mof and not re.match(r"this\s+(?:Regulation|Directive)\b", after[mof.end():], re.I):
                return m.group(0)
            return _link_list_self(m.group(1), m.group(2), act_id, self_ids)
        return ART_LIST.sub(repl, text)
    return pass_self


def pass_citations(text):
    """Remaining standalone citation groups -> act-level refs (each spec)."""
    out, pos = [], 0
    m = KIND_RE.search(text, pos)
    while m:
        grp = render_citation_group(text, m.start(), m.end())
        if grp:
            rendered, gend, _ = grp
            out.append(text[pos:m.start()])
            out.append(rendered)
            pos = gend
        else:
            out.append(text[pos:m.end()])
            pos = m.end()
        m = KIND_RE.search(text, pos)
    out.append(text[pos:])
    return "".join(out)


def make_pass_para_self(act_id, self_ids):
    # Same-act German "§ N" references, unless they point into another statute
    # ("§ N ... des/der <Gesetz>"), which we leave as plain text.
    def pass_para_self(text):
        def repl(m):
            after = text[m.end():]
            if re.match(DE_TAIL + r"\s+(?:des|der)\s+[A-Z\u00c4\u00d6\u00dc]", after):
                return m.group(0)
            def one(mm):
                n = mm.group(0)
                return a_self(act_id, n, n) if art_id_of(n) in self_ids else n
            return NUM.sub(one, m.group(0))
        return PARA.sub(repl, text)
    return pass_para_self


# --------------------------------------------------------------------------- #
# German citation passes (cross-act only)
#
# German acts cite EU instruments as "Verordnung (EU) 2019/881",
# "Verordnung (EU) Nr. 648/2012", "Richtlinie 2014/65/EU" and by short name
# ("NIS-2-Richtlinie"). These resolve to the same permanent CELEX ids as the
# English forms, so hosted targets become in-app jumps at runtime.
# --------------------------------------------------------------------------- #
DE_KIND_RE = re.compile(r"\b(Verordnung(?:en)?|Richtlinie(?:n)?)\b")
DE_SPEC_RE = re.compile(
    r"\((?:EU|EG|EWG)\)\s*Nr\.\s*(\d{1,4})/(\d{4})"    # (EU) Nr. 648/2012 -> num/year
    r"|\((?:EU|EG|EWG)\)\s*(\d{4})/(\d{1,4})"          # (EU) 2019/881     -> year/num
    r"|(\d{4})/(\d{1,4})/(?:EU|EG|EWG)"                # 2014/65/EU        -> year/num
)
DE_SEP_RE = re.compile(r"\s*(?:,|und|oder|bis|\u2013|-)\s+", re.I)
DE_OF = r"(?:\s*\([^)]*\)|\s*,|\s+(?:Absatz|Abs\.|Unterabsatz|Satz|Nummer|Nr\.|Buchstabe|Ziffer|Doppelbuchstabe)\s*[0-9a-z]+(?:\s+[0-9a-z]+)?|\s+(?:und|oder|bis))*\s+(?:des|der)\s+"
DE_ART_LIST = re.compile(
    r"\b(Artikeln?)\s+(\d+[a-z]?(?:\s*(?:,|und|oder|bis|\u2013|-)\s*\d+[a-z]?)*)"
)
DE_TREATY_ARTICLE = re.compile(
    r"^\s*(?:(?:Absatz|Abs\.|Unterabsatz|Satz|Nummer|Nr\.|Buchstabe|Ziffer)"
    r"\s*[0-9a-z]+\s*)*(?:AEUV|EUV|EAGV|EMRK|GRCh|GRC)\b",
    re.I,
)
# Short-name citations mapped to their permanent CELEX id.
NAMED_CELEX = {"nis-2-richtlinie": "32022L2555"}
NAMED_RE = re.compile(r"NIS-?\s*2-\s*Richtlinie", re.I)


def de_letter(word):
    return "R" if word[:1].lower() == "v" else "L"


def de_spec_celex(m, letter):
    if m.group(1):
        return celex(letter, m.group(2), m.group(1))
    if m.group(3):
        return celex(letter, m.group(3), m.group(4))
    return celex(letter, m.group(5), m.group(6))


def render_de_group(text, lead_start, lead_end):
    """Render a German "Verordnung/Richtlinie (EU) …" citation group."""
    letter = de_letter(text[lead_start:lead_end])
    i = WS_RE.match(text, lead_end).end()
    m0 = DE_SPEC_RE.match(text, i)
    if not m0:
        return None  # e.g. "dieser Verordnung" (no number spec) -> not a target

    rest, end = [], m0.end()
    while True:
        sm = DE_SEP_RE.match(text, end)
        if not sm:
            break
        nm = DE_SPEC_RE.match(text, sm.end())
        if not nm:
            break
        rest.append((sm, nm))
        end = nm.end()

    first_cx = de_spec_celex(m0, letter)
    if not rest:
        return a_cross_act(first_cx, text[lead_start:end]), end, first_cx
    parts = [text[lead_start:m0.start()], a_cross_act(first_cx, m0.group(0))]
    for sm, nm in rest:
        parts.append(sm.group(0))
        parts.append(a_cross_act(de_spec_celex(nm, letter), nm.group(0)))
    return "".join(parts), end, first_cx


def render_de_target(text, pos):
    """Render whichever citation target begins at ``pos`` (kind group or named)."""
    km = DE_KIND_RE.match(text, pos)
    if km:
        return render_de_group(text, km.start(), km.end())
    nm = NAMED_RE.match(text, pos)
    if nm:
        cx = NAMED_CELEX[nm.group(0).lower().replace(" ", "")]
        return a_cross_act(cx, nm.group(0)), nm.end(), cx
    return None


def make_pass_de_self(act_id, self_ids):
    def pass_de_self(text):
        def repl(m):
            after = text[m.end():]
            if re.match(DE_OF, after) or DE_TREATY_ARTICLE.match(after):
                return m.group(0)
            return _link_list_self(m.group(1), m.group(2), act_id, self_ids)
        return DE_ART_LIST.sub(repl, text)
    return pass_de_self


def pass_de_cross(text):
    """"Artikel N … der Verordnung/Richtlinie …" -> cross-act article refs."""
    out, pos = [], 0
    m = DE_ART_LIST.search(text, pos)
    while m:
        of = re.match(DE_OF, text[m.end():])
        grp = render_de_target(text, m.end() + of.end()) if of else None
        if grp:
            rendered, gend, first_cx = grp
            out.append(text[pos:m.start()])
            out.append(_link_list_cross(m.group(1), m.group(2), first_cx))
            out.append(text[m.end():m.end() + of.end()])   # the " … der " glue
            out.append(rendered)
            pos = gend
        else:
            out.append(text[pos:m.end()])
            pos = m.end()
        m = DE_ART_LIST.search(text, pos)
    out.append(text[pos:])
    return "".join(out)


def pass_de_citations(text):
    """Standalone German citations -> act-level refs (kind groups and named)."""
    out, pos = [], 0
    while True:
        km = DE_KIND_RE.search(text, pos)
        nm = NAMED_RE.search(text, pos)
        if not km and not nm:
            break
        if km and (not nm or km.start() <= nm.start()):
            grp = render_de_group(text, km.start(), km.end())
            if grp:
                rendered, gend, _ = grp
                out.append(text[pos:km.start()])
                out.append(rendered)
                pos = gend
            else:
                out.append(text[pos:km.end()])
                pos = km.end()
        else:
            cx = NAMED_CELEX[nm.group(0).lower().replace(" ", "")]
            out.append(text[pos:nm.start()])
            out.append(a_cross_act(cx, nm.group(0)))
            pos = nm.end()
    out.append(text[pos:])
    return "".join(out)


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #
def self_article_ids(articles):
    ids = set()
    for a in articles or []:
        if a.get("id"):
            ids.add(a["id"])
        num = None
        mt = re.search(r"\b(\d+[a-z]?)\b", a.get("title") or "")
        if mt:
            num = mt.group(1)
        if num:
            ids.add(art_id_of(num))
    return ids


def has_german_article_headings(articles):
    return any(
        re.match(r"^Artikel\s+\d+[a-z]?\b", article.get("title") or "", re.I)
        for article in articles or []
    )


def link_text(text, act_id, self_ids, german_article_act=False):
    t = unwrap(text)
    t = outside_anchors(t, pass_cross)
    t = outside_anchors(t, make_pass_self(act_id, self_ids))
    t = outside_anchors(t, make_pass_para_self(act_id, self_ids))
    t = outside_anchors(t, pass_citations)
    if german_article_act:
        t = outside_anchors(t, make_pass_de_self(act_id, self_ids))
    t = outside_anchors(t, pass_de_cross)
    t = outside_anchors(t, pass_de_citations)
    return t


def process_act(path, act_id):
    with open(path) as f:
        doc = json.load(f)
    articles = doc["articles"] if isinstance(doc, dict) else doc
    self_ids = self_article_ids(articles)
    german_article_act = has_german_article_headings(articles)

    n_refs = 0
    for art in articles:
        for para in art.get("paragraphs", []):
            before = para.get("text", "")
            after = link_text(before, act_id, self_ids, german_article_act)
            if after != before:
                para["text"] = after
            n_refs += after.count('class="ref"')

    with open(path, "w") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return n_refs


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Relink cross-references in act JSON files.")
    parser.add_argument(
        "only",
        nargs="*",
        help="Optional act ids or paths to process (default: all acts in data/index.json).",
    )
    parser.add_argument(
        "--update-db",
        action="store_true",
        help="Run tools/build_index_db.py after relinking to sync data/index.db.",
    )
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    index = json.load(open(INDEX))
    only = set(args.only)
    total = 0
    for entry in index["acts"]:
        if only and entry["id"] not in only and entry["path"] not in only:
            continue
        path = os.path.join(APP, entry["path"])
        refs = process_act(path, entry["id"])
        total += refs
        print(f"{entry['id']:28} refs={refs}")
    print(f"total ref anchors: {total}")
    if args.update_db:
        build_script = os.path.join(APP, "tools", "build_index_db.py")
        print("syncing sqlite index database ...")
        subprocess.run([sys.executable, build_script], check=True)
    else:
        print("tip: run `python3 tools/build_index_db.py` (or use --update-db) to sync index.db")


if __name__ == "__main__":
    main(sys.argv[1:])
