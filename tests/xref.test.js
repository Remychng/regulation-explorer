// Runtime (integration) tests for cross-reference resolution.
//
// WHAT THIS COVERS
//   The click/hover behaviour in app.js: an anchor with data-ref="scheme:id"
//   resolves against the registry-derived authToActId map and either jumps
//   in-app (hosted) or lets the EUR-Lex href open (not hosted); same-act
//   anchors (no data-ref) navigate within the current act. This is the only
//   layer that tests the actual browser wiring end-to-end.
//
// HOW IT RUNS
//   Boots the real app.js in jsdom (see jsdom_harness.js) and drives it through
//   the DOM. Run with:  node --test tests/
const { test, before } = require('node:test');
const assert = require('node:assert');
const { bootApp } = require('./jsdom_harness');

let app;
before(async () => { app = await bootApp(); });

test('app loads and populates the sidebar', () => {
  assert.ok(app.doc.querySelector('.article-link'));
});

test('act root shows applicable legal entity shorthand labels', async () => {
  await app.openAct('act_eu_dora_reg_2022_2554');
  const applicability = app.doc.getElementById('legalEntityApplicability');
  const chips = [...applicability.querySelectorAll('.legal-entity-chip')];

  assert.strictEqual(applicability.hidden, false);
  assert.match(applicability.textContent, /^Applies to/);
  assert.deepStrictEqual(chips.map((chip) => chip.textContent), ['CEAG', 'CHAG', 'DBAG', 'ECAG', 'ERG']);
  assert.strictEqual(chips[0].title, 'Clearstream Europe AG');
});

test('act root identifies when the CSV has no matching regulation', async () => {
  await app.openAct('act_eu_ai_act_2024_1689');
  const applicability = app.doc.getElementById('legalEntityApplicability');
  assert.strictEqual(applicability.hidden, false);
  assert.strictEqual(applicability.textContent, 'Applicability data not available');
});

test('DORA bundle root shows the union of descendant applicability', async () => {
  await app.openAct('act_eu_dora_reg_2022_2554');
  app.nav('#bundle:bundle_dora');
  await app.tick();
  const chips = [...app.doc.querySelectorAll('#legalEntityApplicability .legal-entity-chip')];
  assert.deepStrictEqual(chips.map((chip) => chip.textContent), ['CEAG', 'CHAG', 'DBAG', 'ECAG', 'ERG']);
});

test('DORA technical-standard folders show descendant applicability', async () => {
  app.nav('#bundle:bundle_dora_rts');
  await app.tick();
  const shorthandLabels = () => [...app.doc.querySelectorAll('#legalEntityApplicability .legal-entity-chip')]
    .map((chip) => chip.textContent);
  assert.deepStrictEqual(shorthandLabels(), ['CEAG', 'CHAG', 'DBAG', 'ECAG', 'ERG']);

  app.nav('#bundle:bundle_dora_its');
  await app.tick();
  assert.deepStrictEqual(shorthandLabels(), ['CEAG', 'CHAG', 'DBAG', 'ECAG', 'ERG']);
});

test('DORA family scope is shown on the directive and technical standards', async () => {
  const shorthandLabels = () => [...app.doc.querySelectorAll('#legalEntityApplicability .legal-entity-chip')]
    .map((chip) => chip.textContent);

  await app.openAct('act_eu_dora_dir_2022_2556');
  assert.deepStrictEqual(shorthandLabels(), ['CEAG', 'CHAG', 'DBAG', 'ECAG', 'ERG']);

  await app.openAct('act_eu_dora_rts_2024_1774');
  assert.deepStrictEqual(shorthandLabels(), ['CEAG', 'CHAG', 'DBAG', 'ECAG', 'ERG']);
});

test('cross-act article ref jumps to the target act + article', async () => {
  await app.openAct('act_eu_dora_rts_2024_1774'); // RTS 1 cites DORA Regulation
  const a = app.doc.querySelector('a.ref[data-ref="celex:32022R2554"][data-article="9"]');
  assert.ok(a, 'expected a cross-act anchor to DORA reg art 9');

  const ev = app.click(a); await app.tick();
  assert.strictEqual(ev.defaultPrevented, true, 'should be intercepted (in-app)');
  assert.match(app.hash(), /act_eu_dora_reg_2022_2554:art_9/);
});

test('cross-act ref to a different hosted act resolves correctly', async () => {
  await app.openAct('act_eu_csdr_2014_0909');
  const m = app.doc.querySelector('a.ref[data-ref="celex:32014L0065"][data-article]');
  assert.ok(m, 'expected CSDR -> MiFID II cross ref');
  const art = m.getAttribute('data-article');
  const ev = app.click(m); await app.tick();
  assert.strictEqual(ev.defaultPrevented, true);
  assert.match(app.hash(), new RegExp(`act_eu_mifid2_2014_0065:art_${art}`));
});

test('non-hosted ref is NOT intercepted (EUR-Lex fallback opens)', async () => {
  const hosted = new Set((app.registry().acts || []).map((e) => e.authId).filter(Boolean));
  await app.openAct('act_eu_dora_reg_2022_2554');
  const ext = [...app.doc.querySelectorAll('a.ref[data-ref]')]
    .find((x) => !hosted.has(x.getAttribute('data-ref')));
  assert.ok(ext, 'expected at least one external ref');
  assert.match(ext.getAttribute('href'), /eur-lex\.europa\.eu.*CELEX:/);

  const ev = app.click(ext); await app.tick();
  assert.strictEqual(ev.defaultPrevented, false, 'external ref must use its href');
});

test('same-act (self) ref navigates within the act', async () => {
  await app.openAct('act_eu_dora_reg_2022_2554');
  const self = app.doc.querySelector('a.ref:not([data-ref])[href^="#a:act_eu_dora_reg_2022_2554:"]');
  assert.ok(self, 'expected a self reference');
  const ev = app.click(self); await app.tick();
  assert.strictEqual(ev.defaultPrevented, true);
  assert.match(app.hash(), /act_eu_dora_reg_2022_2554/);
});

test('paragraph citation uses the current regulation name', async () => {
  await app.openAct('act_eu_gdpr_2016_0679');
  const citationButton = app.doc.querySelector(
    '.paragraph-tool-button[aria-label="Copy citation for this paragraph"]',
  );
  assert.ok(citationButton, 'expected a paragraph citation button');

  app.click(citationButton);
  await app.tick();

  assert.match(app.clipboard(), /^GDPR Article/);
  assert.doesNotMatch(app.clipboard(), /EMIR/);
});

// --- Copy "Link" tools: permalinks at paragraph / article / regulation level ---

test('copy Link on a paragraph yields a scoped paragraph permalink', async () => {
  await app.openAct('act_de_boersg_2007');
  const para = app.doc.querySelector('#paragraphsContainer .article-paragraph[id]');
  assert.ok(para, 'expected a paragraph with an id');
  const linkBtn = para.querySelector(
    '.paragraph-tool-button[aria-label="Copy direct link to this paragraph"]',
  );
  assert.ok(linkBtn, 'expected a paragraph Link button');

  app.click(linkBtn); await app.tick();
  assert.match(app.clipboard(), new RegExp(`#a:act_de_boersg_2007:${para.id}$`));
});

test('copy Link on an article heading yields an article permalink', async () => {
  await app.openAct('act_de_boersg_2007');
  const heading = app.doc.querySelector('.act-article-title');
  assert.ok(heading, 'expected a per-article heading in the act view');
  const linkBtn = heading.querySelector('.paragraph-tool-button[aria-label="Copy direct link"]');
  assert.ok(linkBtn, 'expected an article-heading Link button');

  app.click(linkBtn); await app.tick();
  assert.match(app.clipboard(), /#a:act_de_boersg_2007:art_1$/);
});

test('copy Link on the act root yields an act permalink', async () => {
  await app.openAct('act_de_boersg_2007');
  const title = app.doc.getElementById('articleTitle');
  const linkBtn = title.querySelector('.paragraph-tool-button[aria-label="Copy direct link"]');
  assert.ok(linkBtn, 'expected an act-root Link button');

  app.click(linkBtn); await app.tick();
  assert.match(app.clipboard(), /#act:act_de_boersg_2007$/);
});

test('copy Citation on an article heading includes the regulation and section', async () => {
  await app.openAct('act_de_boersg_2007');
  const heading = app.doc.querySelector('.act-article-title');
  const citeBtn = heading.querySelector('.paragraph-tool-button[aria-label="Copy citation"]');
  assert.ok(citeBtn, 'expected an article-heading Citation button');

  app.click(citeBtn); await app.tick();
  assert.match(app.clipboard(), /Börsengesetz.*§ 1/);
});

test('copy Link on a folder (bundle) heading yields a bundle permalink', async () => {
  app.nav('#bundle:bundle_dora'); await app.tick();
  const title = app.doc.getElementById('articleTitle');
  const linkBtn = title.querySelector('.paragraph-tool-button[aria-label="Copy direct link"]');
  assert.ok(linkBtn, 'expected a bundle Link button');

  app.click(linkBtn); await app.tick();
  assert.match(app.clipboard(), /#bundle:bundle_dora$/);
});

test('the selected act lists its matching articles in the side panel during search', async () => {
  const input = app.doc.getElementById('searchInput');
  input.value = 'processing';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await app.tick(); // search is debounced ~180ms < tick 200ms
  await app.tick(); // then the first match is opened via a hash change

  const layout = app.doc.querySelector('.layout');
  assert.ok(layout.classList.contains('has-act-panel'), 'expected the article panel to open for the first match');
  assert.ok(app.doc.querySelectorAll('#actArticleList > li').length > 0, 'expected articles in the panel');
  assert.ok(
    !app.doc.querySelector('#articleList .article-link.opens-panel + .act-article-list'),
    'articles should not be rendered inline in the sidebar',
  );

  // Clicking the open act again closes the panel.
  app.doc.querySelector('#articleList .article-link.opens-panel.is-expanded').click();
  await app.tick();
  assert.ok(!layout.classList.contains('has-act-panel'), 'panel should close after clicking the open act');
});
