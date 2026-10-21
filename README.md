# Regulation Browser (CISO RegBro)

A static, client-side browser for legal acts. No build step: `index.html` +
`app.js` + `styles.css` reading JSON via `fetch()`.

## Local development

Install the Python tooling and parser dependencies:

```bash
python3 -m pip install -r requirements.txt
```

`fetch()` is blocked on `file://`, so serve over HTTP:

```bash
python -m http.server 5500   # then open http://localhost:5500
```

(Any static server works — VS Code **Live Server** is fine too.)

## Data model

- **Act** (`type:"act"`) — a legal act: `id`, `title`, `heading`, `meta`, and
  either an `articles` array (multi-article) or a `paragraphs` array
  (single-article). Paragraphs are `{ id, text, class }`; `text` is HTML.
- **Bundle** (`type:"bundle"`) — a folder of related acts: `id`, `title`,
  `members` (each `{ ref, label }`), and may nest other bundles.
- **Registry** — [`data/index.json`](data/index.json): lists every act/bundle with
  its `id`, `path`, `label`, `jurisdiction`, and (for citable acts) `authId`. The
  app loads this first, then fetches each `path`.
- **Hash routing** — `#act:<id>`, `#bundle:<id>`, and article hashes like
  `#a:<act>:art_N`.

## Act identifiers (`id`)

The `id` is the app's **internal routing handle** (used in the registry, bundle
`ref`s, and URL hashes). It only has to be unique, readable, and permanent — it is
**not** the act's legal identifier (that's `authId`, below).

```
act_<jurisdiction>_<mnemonic>[_<type>]_<year>[_<number>]
```

| Component | Rule |
|---|---|
| `<jurisdiction>` | Lowercase code: `eu`, `de`, `fr`, `us`, … Namespaces ids so jurisdictions never collide. |
| `<mnemonic>` | Short acronym/short-title: `gdpr`, `emir`, `mifid2`, `nis2`, `data_act`, `dora`, `boersg`. |
| `<type>` | Only to disambiguate acts sharing a mnemonic (e.g. DORA): `reg`, `dir`, `rts`, `its`, `del`. |
| `<year>` | 4-digit year of the official number (or enactment year for un-numbered national law). |
| `<number>` | Official number, 4-digit zero-padded (the CELEX tail for EU acts). Omitted when none exists. |

**Rules of thumb:** ids are identity-bound, never positional (`RTS 1` is a *label*;
the id `act_eu_dora_rts_2024_1774` is fixed to that regulation) — **never reuse an
id for a different act.** Carrying the full `year_number` keeps ids stable when
siblings are added. `id` ≠ `authId` ≠ filename (`path`).

Examples: `act_eu_gdpr_2016_0679`, `act_eu_mifid2_2014_0065`,
`act_eu_dora_reg_2022_2554`, `act_eu_dora_rts_2024_1774`, `act_de_boersg_2007`,
`act_fr_cmf_2000` *(future)*, `act_us_glba_1999` *(future)*.

## References (internal & cross-act)

Links are written **once at convert time** and injected into each paragraph's HTML;
the runtime only decides where each one goes (it never re-parses text).

**Convert time** — `python3 tools/link_references.py` (idempotent). Scans each
paragraph and writes `<a class="ref">` anchors:

- **same-act** (`Article N`, German `§ N`) → `href="#a:<thisAct>:art_N"`, no id
- **cross-act** (`Article N of Regulation (EU) 2022/2554`, incl. compound lists) →
  `data-ref="celex:32022R2554"` (+ `data-article="N"`), plus an EUR-Lex `href` fallback

The identifier is **scheme-qualified** (`celex:…`, later `cfr:…`, `eli:…`), computed
straight from the citation text — no registry lookup here.

**Run time** — `app.js` builds `authToActId = { "celex:…" → act id }` from the
registry once, then on click/hover of an `a.ref`:

- **no `data-ref`** → same-act: follow the `#a:<act>:art_N` hash
- **`data-ref`** → look it up: **hit** → in-app jump; **miss** → the `href` (EUR-Lex) opens

Navigation is in-memory (id → loaded object + hash); `path` is used only for the
initial fetch. Because the map is rebuilt each load, hosting a new act
auto-upgrades every existing link to it — no re-convert. Supporting a new
jurisdiction only needs a citation matcher in `link_references.py` (emitting
`data-ref="<scheme>:<id>"`) and an `authId` on its acts; the rest is scheme-agnostic.

## Adding a regulation (end to end)

1. **Produce the act JSON** — parse the source into the act shape
   (`articles[].paragraphs[]`) with a parser in [`tools/parsers/`](tools/parsers/),
   or hand-author it. Save under `regulations-data/`.
2. **Register it** in [`data/index.json`](data/index.json): `id`, `path`, `label`,
   `jurisdiction`, and — for citable acts — an `authId` (e.g. `celex:32016R0679`).
   The `authId` is what makes it a cross-reference target.
3. **Bundle it** (optional) — add its `ref` to a folder in [`data/bundles/`](data/bundles/).
4. **Link references** — `python3 tools/link_references.py` (re-links all acts;
   existing citations to the new act auto-upgrade to in-app).
5. **Verify** — serve locally and check it loads and a few cross-references resolve.

No app-code changes are needed — the id scheme, `authToActId`, and resolver are
data-driven. Only a new *citation style* needs a matcher in `tools/link_references.py`.

## Index database

`data/index.db` is a generated SQLite index used by tooling/server-side workflows.
It mirrors the flat `data/index.json` registry and stores richer metadata
(acts, bundles, tags, and extracted cross-references).

Initialise/update it with:

```bash
python3 tools/build_index_db.py
```

First run creates `data/index.db` from `schema.sql` and seeds all rows.
Subsequent runs upsert current acts/bundles and re-sync tags, references, and
bundle membership (including removals from `data/index.json`).

`data/index.json` remains the browser app source of truth for loaded content.
The DB is a derived index for querying/integration, and the script also writes
`data/index_meta.json` (lightweight `id -> celex` metadata for runtime lookups).

## Legal entity applicability

The regulation root view displays shorthand labels for legal entities listed in
`data/source/legal_entity_regulation_detail.csv`. Regenerate the browser mapping
after the CSV or registry changes:

```bash
python3 tools/build_legal_entity_applicability.py
```

The generated `data/legal_entity_applicability.json` maps stable act ids to the
matching legal entities and bundle ids to the union of their descendant acts.
For regulation families such as DORA, the top-level bundle scope is displayed
consistently on every descendant act and folder. Standalone regulations with no
matching CSV row are marked as having no available applicability data.

## Updating all regulations

Run the complete RegBro data refresh with one command:

```bash
python3 tools/update_regulations.py
```

The updater visits every registry act whose `status` is `In Force` (the default),
checks EUR-Lex acts identified by `authId`, updates changed article content, then
re-links the complete corpus and rebuilds `data/index.db` and
`data/index_meta.json`. Unsupported sources are reported and skipped. Use
`--check` to report pending changes without writing, or pass act ids/paths to
limit a run. Detailed function and update activity is written to
`logs/update_regulations.log`; logs rotate at 100 MB.

Acts can define an `update` object in `data/index.json` with a `url` and parser
name (`consolidated`, `consolidated_lists`, `oj`, `oj_lists`, `boersengesetz`,
or `nis2_bsig`). Set `status` to another schema-supported value (for example
`Repealed`) to exclude an act from automatic updates; `dateInForce` is also
mirrored into the generated database.

### List-aware EU parsers

The standard `oj` and `consolidated` parsers can flatten lists nested inside a
paragraph into one block. The `oj_lists` and `consolidated_lists` variants split
list points into separate blocks and mark nested points with `list-item-l1` and
`list-item-l2`. They also preserve text that is not wrapped in a paragraph
element.

Currently, GDPR uses `oj_lists`, and DSGVO uses `consolidated_lists`. The
original parsers remain available for other acts.

Comparisons against tracked source HTML indicate these registered acts may
benefit from migration:

| Act | Saved source | Parser format | Blocks: current to list-aware |
|---|---|---|---:|
| MiFID II | [`regulations-data/02014L0065.html`](regulations-data/02014L0065.html) | `consolidated` | 752 to 1,332 |
| CSDR | [`regulations-data/32014R0909.html`](regulations-data/32014R0909.html) | `oj` | 340 to 698 |
| AI Act | [`regulations-data/CELEX_02024R1689-20260727_EN_TXT.html`](regulations-data/CELEX_02024R1689-20260727_EN_TXT.html) | `consolidated` | 806 to 1,196 |
| Cybersecurity Act | [`regulations-data/CELEX_32019R0881_EN_TXT.html`](regulations-data/CELEX_32019R0881_EN_TXT.html) | `oj` | 324 to 483 |
| NIS2 | [`regulations-data/CELEX_32022L2555_EN_TXT.html`](regulations-data/CELEX_32022L2555_EN_TXT.html) | `oj` | 241 to 510 |

These counts come from the saved source snapshots and indicate additional
block splitting, not by themselves that every output difference is correct.
Migrate acts individually: set their `update.parser` in `data/index.json`,
re-import with `python3 tools/update_regulations.py <act-id>`, then review the
result against its source. Some comparisons also showed text the old parser had
omitted, so check content as well as block counts.

Splitting blocks changes paragraph IDs. Saved links to paragraph-level IDs may
therefore point to different text, although article-level IDs are unchanged.
Acts using other source formats or parsers, such as Börsengesetz, BDSG, and
BSIG, should not be switched to these variants without a source-specific test.
