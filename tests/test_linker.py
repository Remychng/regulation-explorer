"""Unit tests for the reference linker (tools/link_references.py).

WHAT THIS COVERS
    The pure text -> HTML linking logic that turns citations in an act's
    paragraph text into <a class="ref"> anchors. This is the highest-ROI suite:
    the functions are pure (string in, string out), and this is where the
    trickiest bugs live (plural/compound citations, self vs cross-act, the
    German "§" handling, and the guards that prevent mis-linking).

HOW IT LOADS THE MODULE
    tools/link_references.py is a script, not an installed package, so we load
    it by path with importlib.
"""
import importlib.util
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "link_references", os.path.join(ROOT, "tools", "link_references.py")
)
lr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lr)


def link(text, act="act_eu_x_2020_0001", ids=frozenset(), german_article_act=False):
    """Convenience wrapper around link_text(text, act_id, self_article_ids)."""
    return lr.link_text(text, act, set(ids), german_article_act)


# --------------------------------------------------------------------------- #
# CELEX is derived from the citation text by formula (no lookups)
# --------------------------------------------------------------------------- #
def test_celex_formula():
    # letter + year + zero-padded number
    assert lr.celex("R", "2022", "2554") == "32022R2554"
    assert lr.celex("R", "2012", "648") == "32012R0648"
    assert lr.celex("L", "2014", "65") == "32014L0065"


def test_art_id_from_number():
    assert lr.art_id_of("9") == "art_9"
    assert lr.art_id_of("9a") == "art_9a"


# --------------------------------------------------------------------------- #
# Cross-act references: "Article N of <act>" -> data-ref + data-article
# --------------------------------------------------------------------------- #
def test_cross_act_article():
    out = link("Article 11 of Regulation (EU) 2022/2554")
    assert 'data-ref="celex:32022R2554"' in out
    assert 'data-article="11"' in out


def test_cross_act_inline_paragraph():
    # the common "Article 4(1) of Directive 2014/65/EU" form (paren before "of")
    out = link("as defined in Article 4(1) of Directive 2014/65/EU")
    assert 'data-ref="celex:32014L0065"' in out
    assert 'data-article="4"' in out


def test_compound_list_links_each_act():
    out = link(
        "Articles 10 to 14 of Regulations (EU) No 1093/2010, "
        "(EU) No 1094/2010 and (EU) No 1095/2010"
    )
    for cx in ("32010R1093", "32010R1094", "32010R1095"):
        assert f'data-ref="celex:{cx}"' in out


def test_bare_citation_becomes_act_ref():
    out = link("in accordance with Regulation (EU) 2016/679")
    assert 'data-ref="celex:32016R0679"' in out
    assert "data-article" not in out  # act-level, no article


# --------------------------------------------------------------------------- #
# Same-act references: bare "Article N" -> in-app hash, no data-ref
# --------------------------------------------------------------------------- #
def test_self_ref_when_article_exists():
    out = link("see Article 9", ids={"art_9"})
    assert 'href="#a:act_eu_x_2020_0001:art_9"' in out
    assert "data-ref" not in out  # same-act carries no identifier


def test_self_ref_skipped_when_article_absent():
    # don't link to an article this act doesn't have
    assert "<a" not in link("see Article 9", ids=set())


def test_self_ref_of_this_regulation():
    out = link("referred to in Article 2 of this Regulation", ids={"art_2"})
    assert 'href="#a:act_eu_x_2020_0001:art_2"' in out


# --------------------------------------------------------------------------- #
# Guards against mis-linking
# --------------------------------------------------------------------------- #
def test_treaty_article_not_linked():
    assert "<a" not in link("Article 5 of the Treaty on European Union", ids={"art_5"})


def test_boersg_self_section():
    out = link("nach § 19", ids={"art_19"})
    assert 'href="#a:act_eu_x_2020_0001:art_19"' in out


def test_boersg_skips_other_statute():
    # "§ 2 ... des Wertpapierhandelsgesetzes" points at WpHG, not this act
    out = link("im Sinne des § 2 Absatz 3 des Wertpapierhandelsgesetzes", ids={"art_2"})
    assert "<a" not in out


def test_german_self_article_references():
    out = link(
        "siehe Artikel 9 und 10 dieser Verordnung",
        ids={"art_9", "art_10"},
        german_article_act=True,
    )
    assert 'href="#a:act_eu_x_2020_0001:art_9"' in out
    assert 'href="#a:act_eu_x_2020_0001:art_10"' in out
    assert "data-ref" not in out


def test_german_article_reference_to_another_regulation_remains_cross_act():
    out = link(
        "siehe Artikel 8 der Verordnung (EU) 2022/2554",
        ids={"art_8"},
        german_article_act=True,
    )
    assert 'data-ref="celex:32022R2554"' in out
    assert 'data-article="8"' in out
    assert 'href="#a:act_eu_x_2020_0001:art_8"' not in out


def test_german_treaty_article_is_not_linked_to_current_act():
    out = link("Artikel 8 Absatz 1 AEUV", ids={"art_8"}, german_article_act=True)
    assert "<a" not in out


def test_german_same_act_linking_requires_german_article_headings():
    assert lr.has_german_article_headings([{"title": "Artikel 1"}])
    assert not lr.has_german_article_headings([{"title": "§ 1"}])
    assert "<a" not in link("Artikel 1", ids={"art_1"})


# --------------------------------------------------------------------------- #
# Idempotency: re-running the linker must not change already-linked text
# --------------------------------------------------------------------------- #
def test_idempotent():
    once = link("Article 11 of Regulation (EU) 2022/2554", ids={"art_11"})
    twice = link(once, ids={"art_11"})
    assert once == twice
