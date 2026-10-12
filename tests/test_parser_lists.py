"""Tests for the list-aware parser variants used by GDPR and DSGVO."""
import importlib.util
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(ROOT, "tools", "parsers", f"{name}.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


consolidated = load("parser_consolidated_lists")
oj = load("parser_oj_lists")


def blocks(article):
    return [(p["text"], p["class"]) for p in article["paragraphs"]]


def test_consolidated_nested_grid_lists_become_separate_blocks():
    html = """
    <p class="title-article-norm">Artikel 5</p>
    <div class="eli-title"><p>Grundsätze</p></div>
    <div class="norm">
      <span class="no-parag">1.</span>
      <div class="norm inline-element">
        <p class="norm inline-element">Folgendes ist verboten:</p>
        <div class="grid-container grid-list">
          <div class="list grid-list-column-1"><span>a) </span></div>
          <div class="grid-list-column-2">
            <p class="norm">erster Punkt;</p>
            <div class="grid-container grid-list">
              <div class="list grid-list-column-1"><span>(i)</span></div>
              <div class="grid-list-column-2"><p class="norm">verschachtelt.</p></div>
            </div>
          </div>
        </div>
        <div class="grid-container grid-list">
          <div class="list grid-list-column-1"><span>b) </span></div>
          <div class="grid-list-column-2"><p class="norm">zweiter Punkt.</p></div>
        </div>
      </div>
    </div>
    """
    [article] = consolidated.parse(html)
    assert article["id"] == "art_5"
    assert blocks(article) == [
        ("1. Folgendes ist verboten:", ""),
        ("(a) erster Punkt;", "list-item-l1"),
        ("(i) verschachtelt.", "list-item-l2"),
        ("(b) zweiter Punkt.", "list-item-l1"),
    ]


def test_consolidated_keeps_text_that_is_not_wrapped_in_a_paragraph():
    html = """
    <p class="title-article-norm">Artikel 60</p>
    <div class="norm">
      <span class="no-parag">(1)  </span>
      <div class="norm inline-element">Bloßer Text ohne Absatz-Element.</div>
    </div>
    """
    [article] = consolidated.parse(html)
    assert blocks(article) == [("(1) Bloßer Text ohne Absatz-Element.", "")]


def test_consolidated_drops_modref_amendment_notes():
    html = """
    <p class="title-article-norm">Artikel 1</p>
    <div class="norm"><p class="modref">►C2</p><p class="norm">Text.</p></div>
    """
    [article] = consolidated.parse(html)
    assert blocks(article) == [("Text.", "")]


def test_oj_table_rows_become_separate_blocks_with_nesting():
    html = """
    <div class="eli-subdivision" id="art_4">
      <p class="oj-ti-art">Artikel 4</p>
      <div class="eli-title"><p class="oj-sti-art">Begriffsbestimmungen</p></div>
      <div id="004.001">
        <p class="oj-normal">(1)   Im Sinne dieser Verordnung:</p>
        <table><tbody><tr>
          <td><p class="oj-normal">a)</p></td>
          <td>
            <p class="oj-normal">erster Punkt;</p>
            <table><tbody><tr>
              <td><p class="oj-normal">i)</p></td>
              <td><p class="oj-normal">verschachtelt.</p></td>
            </tr></tbody></table>
          </td>
        </tr></tbody></table>
        <table><tbody><tr>
          <td><p class="oj-normal">b)</p></td>
          <td><p class="oj-normal">zweiter Punkt.</p></td>
        </tr></tbody></table>
      </div>
    </div>
    """
    [article] = oj.parse(html)
    assert article["id"] == "art_4"
    assert blocks(article) == [
        ("(1) Im Sinne dieser Verordnung:", ""),
        ("(a) erster Punkt;", "list-item-l1"),
        ("(i) verschachtelt.", "list-item-l2"),
        ("(b) zweiter Punkt.", "list-item-l1"),
    ]


def test_consolidated_keeps_punctuation_attached_to_inline_markup():
    html = """
    <p class="title-article-norm">Article 26</p>
    <div class="norm"><p class="norm">Article 73 applies <span class="italics">mutatis mutandis</span>.</p></div>
    """
    [article] = consolidated.parse(html)
    assert blocks(article) == [("Article 73 applies mutatis mutandis.", "")]


def test_oj_keeps_text_that_is_not_wrapped_in_a_paragraph():
    html = """
    <div class="eli-subdivision" id="art_24">
      <p class="oj-ti-art">Article 24</p>
      <div id="024.001">1.   Bare text without a paragraph element.</div>
      <div id="024.002"><p class="oj-normal">2.   Wrapped text.</p></div>
    </div>
    """
    [article] = oj.parse(html)
    assert blocks(article) == [
        ("1. Bare text without a paragraph element.", ""),
        ("2. Wrapped text.", ""),
    ]
