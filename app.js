const articleListElement = document.getElementById('articleList');
const listMessage = document.getElementById('listMessage');
const statusMessage = document.getElementById('statusMessage');
const searchInput = document.getElementById('searchInput');
const articleNumberElement = document.getElementById('articleNumber');
const articleTitleElement = document.getElementById('articleTitle');
const articleSubtitleElement = document.getElementById('articleSubtitle');
const legalEntityApplicabilityElement = document.getElementById('legalEntityApplicability');
const breadcrumbElement = document.getElementById('breadcrumb');
const paragraphsContainer = document.getElementById('paragraphsContainer');
const prevButton = document.getElementById('prevArticle');
const nextButton = document.getElementById('nextArticle');
const articleNav = document.querySelector('.article-navigation');
const sidePanel = document.querySelector('.side-panel');
const collapseAllButton = document.getElementById('collapseAllButton');
const layoutElement = document.querySelector('.layout');
const articleContentElement = document.querySelector('.article-content');
const actPanel = document.getElementById('actPanel');
const actPanelTitle = document.getElementById('actPanelTitle');
const actPanelList = document.getElementById('actArticleList');
const actPanelClose = document.getElementById('actPanelClose');

let allArticles = [];
let visibleArticles = [];
let allSidebarItems = [];
let visibleSidebarItems = [];
let articleButtons = new Map();
let panelArticleButtons = new Map();
let currentArticleId = null;
let currentArticleSelectionKey = null;
let currentSidebarSelectionKey = null;
// Act whose articles are shown in the side-by-side article panel (at most one).
let expandedActIds = new Set();
let expandedBundleIds = new Set();
// Folder just opened, whose child list should slide in after the next rebuild.
let pendingFolderSlideId = null;
let lastSidebarSignature = null;
let renderedPanelKey = null;
let isUpdatingHash = false;
let currentHighlightedParagraphId = null;
let sidePanelScrollPosition = 0;
let allActs = [];
let allBundles = [];
let lastSearchQuery = '';
let authToActId = {};
let legalEntitiesByItemId = {};

const renderLegalEntityApplicability = (itemId = null) => {
  if (!legalEntityApplicabilityElement) return;

  const entities = itemId ? legalEntitiesByItemId[itemId] || [] : [];
  legalEntityApplicabilityElement.innerHTML = '';
  legalEntityApplicabilityElement.classList.toggle('is-unavailable', Boolean(itemId) && !entities.length);
  legalEntityApplicabilityElement.hidden = !itemId;
  if (!itemId) return;

  const label = document.createElement('span');
  label.className = 'legal-entity-label';
  label.textContent = entities.length ? 'Applies to' : 'Applicability data not available';
  legalEntityApplicabilityElement.appendChild(label);

  entities.forEach((entity) => {
    const chip = document.createElement('abbr');
    chip.className = 'legal-entity-chip';
    chip.textContent = entity.shortName;
    chip.title = entity.name;
    chip.setAttribute('aria-label', entity.name);
    legalEntityApplicabilityElement.appendChild(chip);
  });
};

const legalTooltipSelectors = '.legal-reference, .legal-link, .internal-article-link, .ref';
const LEGAL_TOOLTIP_MAX_CHARS = 1000;
let legalTooltipElement = null;
let legalTooltipContent = null;
let legalTooltipTarget = null;
let legalTooltipHideTimer = null;

const getClosestLegalTooltipTarget = (node) => {
  if (!node || typeof node.closest !== 'function') {
    return null;
  }
  return node.closest(legalTooltipSelectors);
};

const ensureLegalTooltipElement = () => {
  if (legalTooltipElement) {
    return;
  }

  legalTooltipElement = document.createElement('div');
  legalTooltipElement.className = 'legal-tooltip';
  legalTooltipElement.setAttribute('role', 'tooltip');
  legalTooltipElement.setAttribute('aria-hidden', 'true');

  legalTooltipContent = document.createElement('div');
  legalTooltipContent.className = 'legal-tooltip-content';
  legalTooltipElement.appendChild(legalTooltipContent);

  legalTooltipElement.addEventListener('mouseover', () => {
    if (legalTooltipHideTimer) {
      clearTimeout(legalTooltipHideTimer);
      legalTooltipHideTimer = null;
    }
  });

  legalTooltipElement.addEventListener('mouseout', (event) => {
    const related = event.relatedTarget;
    if (related && legalTooltipTarget && legalTooltipTarget.contains(related)) {
      return;
    }
    scheduleLegalTooltipHide();
  });

  document.body.appendChild(legalTooltipElement);
};

const getLegalTooltipText = (element) => {
  if (!element) {
    return '';
  }
  let text;
  const preview = element.getAttribute('data-preview');
  if (preview && preview.trim()) {
    text = preview.trim();
  } else if (element.matches && element.matches('.internal-article-link, .ref')) {
    text = getReferencePreview(element);
  } else {
    text = element.textContent ? element.textContent.trim() : '';
  }
  if (text.length > LEGAL_TOOLTIP_MAX_CHARS) {
    text = `${text.slice(0, LEGAL_TOOLTIP_MAX_CHARS).trimEnd()}...`;
  }
  return text;
};

// Convert an HTML fragment to readable plain text (strips tags, decodes entities).
const htmlToPlainText = (html) => {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return (tmp.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
};

// Build a preview for a reference anchor. Handles both cross-act references
// (data-ref [+ data-article]) and same-act hash references (#a:act:art).
const getReferencePreview = (element) => {
  const refId = refIdOf(element);
  const articleAttr = element.dataset ? element.dataset.article : null;
  const fallback = element.textContent ? element.textContent.trim() : '';

  let targetActId = null;
  let articleId = null;
  let paragraphId = null;

  if (refId) {
    // Cross-act: resolve to a hosted act, else it opens externally.
    targetActId = authToActId[refId];
    if (!targetActId) {
      const scheme = refId.split(':')[0];
      return `${fallback} — opens ${scheme === 'celex' ? 'on EUR-Lex' : 'externally'}`;
    }
    articleId = articleAttr ? artIdOf(articleAttr) : null;
  } else {
    // Same-act: read the in-app hash href.
    const href = element.getAttribute('href') || '';
    if (!href.startsWith('#')) {
      return fallback;
    }
    const parsed = parseHashTarget(href.slice(1));
    if (!parsed.articleId) {
      return fallback;
    }
    targetActId = parsed.parentActId || getCurrentActId();
    articleId = parsed.articleId;
    paragraphId = parsed.paragraphId;
  }

  // Act-level reference (no article): preview the act itself.
  if (!articleId) {
    const act = allActs.find((a) => a.id === targetActId);
    return act ? [act.title, getHeadingText(act)].filter(Boolean).join(' — ') : fallback;
  }

  const article = (targetActId
    ? allArticles.find((item) => item.id === articleId && item._actId === targetActId)
    : null) || allArticles.find((item) => item.id === articleId);
  if (!article) {
    return fallback;
  }

  const titleLine = [article.title, getHeadingText(article)].filter(Boolean).join(' — ');

  let body = '';
  const paragraphs = Array.isArray(article.paragraphs) ? article.paragraphs : [];

  if (paragraphId) {
    const para = paragraphs.find((p) => p && p.id === paragraphId);
    if (para) {
      body = htmlToPlainText(para.text || '');
    }
  }

  if (!body) {
    body = paragraphs
      .map((p) => htmlToPlainText((p && p.text) || ''))
      .filter(Boolean)
      .join('\n\n');
  }

  if (!body) {
    body = htmlToPlainText(getSummaryText(article));
  }

  return [titleLine, body].filter(Boolean).join('\n\n').trim();
};

const positionLegalTooltip = () => {
  if (!legalTooltipElement || !legalTooltipTarget) {
    return;
  }

  const spacing = 12;
  const viewportPadding = 8;
  const targetRect = legalTooltipTarget.getBoundingClientRect();
  const tooltipRect = legalTooltipElement.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let placement = 'top';

  const topPlacement = targetRect.top - tooltipRect.height - spacing;
  const bottomPlacement = targetRect.bottom + spacing;

  let top = topPlacement;

  if (topPlacement < viewportPadding && (bottomPlacement + tooltipRect.height) <= (viewportHeight - viewportPadding)) {
    placement = 'bottom';
    top = bottomPlacement;
  } else if (topPlacement < viewportPadding) {
    top = viewportPadding;
  } else if (topPlacement + tooltipRect.height > viewportHeight - viewportPadding) {
    if ((bottomPlacement + tooltipRect.height) <= (viewportHeight - viewportPadding)) {
      placement = 'bottom';
      top = bottomPlacement;
    } else {
      top = Math.max(viewportPadding, viewportHeight - tooltipRect.height - viewportPadding);
    }
  }

  if (placement === 'bottom' && (top + tooltipRect.height) > (viewportHeight - viewportPadding)) {
    top = Math.max(viewportPadding, viewportHeight - tooltipRect.height - viewportPadding);
  }

  let left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
  const minLeft = viewportPadding;
  const maxLeft = viewportWidth - tooltipRect.width - viewportPadding;

  if (left < minLeft) {
    left = minLeft;
  }

  if (left > maxLeft) {
    left = Math.max(minLeft, maxLeft);
  }

  const tooltipWidth = tooltipRect.width;
  const targetCenter = targetRect.left + (targetRect.width / 2);
  let arrowLeft = targetCenter - left;
  const arrowPadding = 14;
  const arrowMax = tooltipWidth - arrowPadding;

  if (arrowLeft < arrowPadding) {
    arrowLeft = arrowPadding;
  } else if (arrowLeft > arrowMax) {
    arrowLeft = arrowMax;
  }

  legalTooltipElement.dataset.placement = placement;
  legalTooltipElement.style.top = `${Math.round(top)}px`;
  legalTooltipElement.style.left = `${Math.round(left)}px`;
  legalTooltipElement.style.setProperty('--arrow-left', `${Math.round(arrowLeft)}px`);
};

const scheduleLegalTooltipHide = (delay = 120) => {
  if (legalTooltipHideTimer) {
    clearTimeout(legalTooltipHideTimer);
  }
  legalTooltipHideTimer = setTimeout(() => {
    if (!legalTooltipElement) {
      return;
    }
    legalTooltipElement.classList.remove('is-visible');
    legalTooltipElement.setAttribute('aria-hidden', 'true');
    legalTooltipTarget = null;
  }, delay);
};

const hideLegalTooltipImmediate = () => {
  if (legalTooltipHideTimer) {
    clearTimeout(legalTooltipHideTimer);
    legalTooltipHideTimer = null;
  }
  if (!legalTooltipElement) {
    return;
  }
  legalTooltipElement.classList.remove('is-visible');
  legalTooltipElement.setAttribute('aria-hidden', 'true');
  legalTooltipTarget = null;
};

const showLegalTooltip = (target) => {
  if (!target) {
    return;
  }

  ensureLegalTooltipElement();

  if (legalTooltipHideTimer) {
    clearTimeout(legalTooltipHideTimer);
    legalTooltipHideTimer = null;
  }

  const text = getLegalTooltipText(target);
  if (!text) {
    hideLegalTooltipImmediate();
    return;
  }

  legalTooltipTarget = target;
  legalTooltipContent.textContent = text;
  legalTooltipContent.scrollTop = 0;

  legalTooltipElement.style.visibility = 'hidden';
  legalTooltipElement.classList.add('is-visible');
  legalTooltipElement.setAttribute('aria-hidden', 'false');

  // Force layout to ensure accurate measurements before positioning.
  positionLegalTooltip();

  legalTooltipElement.style.visibility = 'visible';
};

const handleLegalTooltipMouseOver = (event) => {
  const target = getClosestLegalTooltipTarget(event.target);
  if (!target) {
    return;
  }
  showLegalTooltip(target);
};

const handleLegalTooltipMouseOut = (event) => {
  const target = getClosestLegalTooltipTarget(event.target);
  if (!target) {
    return;
  }

  const related = event.relatedTarget;
  if (related && (related === legalTooltipElement || (legalTooltipElement && legalTooltipElement.contains(related)))) {
    return;
  }

  if (related && target.contains(related)) {
    return;
  }

  scheduleLegalTooltipHide();
};

const handleLegalTooltipFocusIn = (event) => {
  const target = getClosestLegalTooltipTarget(event.target);
  if (!target) {
    return;
  }
  showLegalTooltip(target);
};

const handleLegalTooltipFocusOut = (event) => {
  const target = getClosestLegalTooltipTarget(event.target);
  if (!target) {
    return;
  }

  const related = event.relatedTarget;
  if (related && (related === legalTooltipElement || (legalTooltipElement && legalTooltipElement.contains(related)))) {
    return;
  }

  hideLegalTooltipImmediate();
};

const initialiseLegalTooltips = () => {
  document.addEventListener('mouseover', handleLegalTooltipMouseOver);
  document.addEventListener('mouseout', handleLegalTooltipMouseOut);
  document.addEventListener('focusin', handleLegalTooltipFocusIn);
  document.addEventListener('focusout', handleLegalTooltipFocusOut);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideLegalTooltipImmediate();
    }
  });

  window.addEventListener('scroll', () => {
    if (!legalTooltipElement || !legalTooltipTarget || !legalTooltipElement.classList.contains('is-visible')) {
      return;
    }
    positionLegalTooltip();
  }, true);

  window.addEventListener('resize', () => {
    if (!legalTooltipElement || !legalTooltipTarget || !legalTooltipElement.classList.contains('is-visible')) {
      return;
    }
    positionLegalTooltip();
  });
};

const getSummaryText = (article) => (article?.summary || article?.summaryTitle || '').trim();
const getHeadingText = (article) => (article?.heading || '').trim();
const getSubtitleText = (item) => ((item?.meta && item.meta.subtitle) ? `${item.meta.subtitle}`.trim() : '');
// Article id from a printed article number (mirrors the converter's art_id_of).
const artIdOf = (n) => 'art_' + String(n == null ? '' : n)
  .replace(/[^0-9A-Za-z]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
// Scheme-qualified identifier of a cross-act ref anchor (e.g. "celex:32022R2554").
// Falls back to the legacy data-celex attribute.
const refIdOf = (el) => {
  if (!el || !el.dataset) return null;
  if (el.dataset.ref) return el.dataset.ref;
  if (el.dataset.celex) return `celex:${el.dataset.celex}`;
  return null;
};
// The act currently open in the reading pane, if any.
const getCurrentActId = () => (currentSidebarSelectionKey && currentSidebarSelectionKey.startsWith('act:'))
  ? currentSidebarSelectionKey.slice(4)
  : null;
const stripHtml = (value) => (value || '').replace(/<[^>]*>/g, ' ');
const normaliseForSearch = (value) => (
  `${value || ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
);
const getSidebarItemKey = (item) => `${item?.type || 'article'}:${item?.id || ''}`;

// Jurisdiction code shown as a prefix on act rows (EU, DE, ...).
const getJurisdiction = (item) => {
  if (!item || item.type !== 'act') return '';
  return (item.meta && item.meta.jurisdiction) || 'EU';
};

// Fill a sidebar title span: optional jurisdiction badge + the item's title.
const setListTitle = (span, item) => {
  span.textContent = '';
  const jurisdiction = getJurisdiction(item);
  if (jurisdiction) {
    const badge = document.createElement('span');
    badge.className = 'list-jurisdiction';
    badge.textContent = jurisdiction;
    span.appendChild(badge);
  }
  span.appendChild(document.createTextNode(item.title || item.id || ''));
};

// Alphabetical comparator for sidebar items (case/accent-insensitive, numeric-aware).
const compareByTitle = (a, b) => `${a.title || a.id || ''}`
  .localeCompare(`${b.title || b.id || ''}`, undefined, { sensitivity: 'base', numeric: true });

// Find a bundle by id, searching top-level bundles and their nested sub-folders.
const findBundleById = (id, bundles = allBundles) => {
  for (const b of bundles) {
    if (!b) continue;
    if (b.id === id) return b;
    if (Array.isArray(b.members)) {
      const nested = b.members.filter((m) => m && m.type === 'bundle');
      const found = findBundleById(id, nested);
      if (found) return found;
    }
  }
  return null;
};
const getArticleSelectionKey = (articleId, parentActId = null) => (
  parentActId ? `article:${parentActId}:${articleId}` : `article:${articleId}`
);

const setExpandedAct = (actId, { allowCollapse = false } = {}) => {
  if (!actId) {
    expandedActIds = new Set();
    return;
  }

  const isAlreadyExpanded = expandedActIds.has(actId);
  if (isAlreadyExpanded && allowCollapse) {
    expandedActIds = new Set();
    return;
  }

  expandedActIds = new Set([actId]);
};

const updateLocationHash = (targetId) => {
  const targetHash = targetId ? `#${targetId}` : '';
  if (window.location.hash === targetHash) {
    return;
  }
  isUpdatingHash = true;
  if (targetId) {
    window.location.hash = targetId;
  } else {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
};

const parseHashTarget = (hashValue) => {
  const rawValue = `${hashValue || ''}`.trim();
  if (!rawValue) {
    return { articleId: null, paragraphId: null, parentActId: null };
  }

  const scopedArticleMatch = rawValue.match(/^a:([^:]+):(.+)$/);
  if (scopedArticleMatch) {
    const parentActId = scopedArticleMatch[1];
    const scopedTarget = scopedArticleMatch[2];
    const separatorIndex = scopedTarget.indexOf('__');
    const articleId = separatorIndex === -1 ? scopedTarget : scopedTarget.slice(0, separatorIndex);
    const paragraphId = separatorIndex === -1 ? null : scopedTarget;

    if (allArticles.some((article) => article.id === articleId && article._actId === parentActId)) {
      return { articleId, paragraphId, parentActId };
    }
  }

  if (allArticles.some((article) => article.id === rawValue)) {
    return { articleId: rawValue, paragraphId: null, parentActId: null };
  }

  const separatorIndex = rawValue.indexOf('__');
  if (separatorIndex !== -1) {
    const candidateArticleId = rawValue.slice(0, separatorIndex);
    if (allArticles.some((article) => article.id === candidateArticleId)) {
      return { articleId: candidateArticleId, paragraphId: rawValue, parentActId: null };
    }
  }

  return { articleId: null, paragraphId: null, parentActId: null };
};

const clearParagraphHighlight = () => {
  if (!currentHighlightedParagraphId) {
    return;
  }

  const previous = document.getElementById(currentHighlightedParagraphId);
  if (previous) {
    previous.classList.remove('is-highlighted');
  }

  currentHighlightedParagraphId = null;
};

const highlightParagraph = (paragraphId, options = {}) => {
  const { behavior = 'smooth', focus = true } = options;

  if (!paragraphId) {
    clearParagraphHighlight();
    return false;
  }

  const target = document.getElementById(paragraphId);
  if (!target) {
    clearParagraphHighlight();
    return false;
  }

  clearParagraphHighlight();
  target.classList.add('is-highlighted');
  currentHighlightedParagraphId = paragraphId;

  try {
    target.scrollIntoView({ block: 'center', behavior });
  } catch (error) {
    target.scrollIntoView({ block: 'center' });
  }

  if (focus) {
    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }
    try {
      target.focus({ preventScroll: true });
    } catch (error) {
      target.focus();
    }
  }

  return true;
};

const createParagraphElement = (paragraphData, article) => {
  if (!paragraphData) {
    return null;
  }

  const rawText = typeof paragraphData === 'string'
    ? paragraphData
    : (paragraphData.text || '');

  const text = rawText.trim();
  if (!text) {
    return null;
  }

  const paragraph = document.createElement('p');
  paragraph.className = 'article-paragraph';
  paragraph.innerHTML = text;

  if (typeof paragraphData === 'object' && paragraphData.id) {
    paragraph.id = paragraphData.id;
  }

  if (typeof paragraphData === 'object' && paragraphData.class) {
    paragraph.classList.add(paragraphData.class);
  }

  attachParagraphTools(paragraph, article, paragraphData);

  return paragraph;
};

const getCurrentIndex = () => visibleArticles.findIndex((article) => article.id === currentArticleId);

const updateListMessage = () => {
  if (!allSidebarItems.length) {
    listMessage.textContent = '';
    return;
  }

  if (!visibleSidebarItems.length) {
    listMessage.textContent = 'No items match your search.';
    return;
  }

  if (!searchInput.value.trim()) {
    listMessage.textContent = '';
    return;
  }

  // Search filters across every act (including those inside folders), so the
  // total is the full act count, not just the top-level sidebar items.
  listMessage.textContent = `${visibleSidebarItems.length} of ${allActs.length} items`;
};

const highlightActiveLink = () => {
  const apply = (button, id) => {
    const isActive = id === currentSidebarSelectionKey || (currentArticleSelectionKey && id === currentArticleSelectionKey);
    button.classList.toggle('is-active', isActive);
    if (isActive) {
      button.setAttribute('aria-current', 'true');
    } else {
      button.removeAttribute('aria-current');
    }
  };
  articleButtons.forEach(apply);
  panelArticleButtons.forEach(apply);
};

const SLIDE_DURATION_MS = 220;
const SLIDE_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

const prefersReducedMotion = () => Boolean(
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
);

const canAnimate = (el) => Boolean(el && typeof el.animate === 'function' && !prefersReducedMotion());

// Slide a freshly inserted list open from zero height.
const slideOpen = (el) => {
  if (!canAnimate(el)) return;
  el.style.overflow = 'hidden';
  const anim = el.animate(
    [{ height: '0px', opacity: 0 }, { height: `${el.scrollHeight}px`, opacity: 1 }],
    { duration: SLIDE_DURATION_MS, easing: SLIDE_EASING },
  );
  anim.onfinish = () => { el.style.overflow = ''; };
  anim.oncancel = anim.onfinish;
};

// Slide a list closed, then run `done` (which typically rebuilds the sidebar).
const slideClosed = (el, done) => {
  if (!canAnimate(el)) {
    done();
    return;
  }
  el.style.overflow = 'hidden';
  const anim = el.animate(
    [{ height: `${el.scrollHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
    { duration: SLIDE_DURATION_MS, easing: SLIDE_EASING, fill: 'forwards' },
  );
  anim.onfinish = done;
};

// Restart a short CSS enter animation on an element.
const playEnterAnimation = (el, className) => {
  if (!el || prefersReducedMotion()) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
};

const updateNavigationButtons = () => {
  const index = getCurrentIndex();

  if (!visibleArticles.length || index === -1) {
    prevButton.disabled = true;
    nextButton.disabled = true;
    // Pagination only makes sense inside a single-article view.
    if (articleNav) articleNav.hidden = true;
    return;
  }

  if (articleNav) articleNav.hidden = false;
  prevButton.disabled = index <= 0;
  nextButton.disabled = index >= visibleArticles.length - 1;
};

const updateStatus = () => {
  if (!allSidebarItems.length) {
    statusMessage.textContent = '';
    return;
  }

  if (!visibleSidebarItems.length) {
    statusMessage.textContent = 'No items match your search.';
    return;
  }

  if (!currentSidebarSelectionKey) {
    statusMessage.textContent = 'Select an act or folder from the navigation.';
    return;
  }

  const index = visibleSidebarItems.findIndex((item) => getSidebarItemKey(item) === currentSidebarSelectionKey);
  if (index === -1) {
    statusMessage.textContent = '';
    return;
  }

  const selectedItem = visibleSidebarItems[index];
  if (!selectedItem) {
    statusMessage.textContent = '';
    return;
  }

  statusMessage.textContent = '';
};

// Find the folder path (root -> target) for a bundle id, including nested folders.
const findBundlePath = (id, bundles = allBundles, trail = []) => {
  for (const b of bundles) {
    if (!b) continue;
    const nextTrail = [...trail, b];
    if (b.id === id) return nextTrail;
    if (Array.isArray(b.members)) {
      const nested = b.members.filter((m) => m && m.type === 'bundle');
      const found = findBundlePath(id, nested, nextTrail);
      if (found) return found;
    }
  }
  return null;
};

// Find the folder chain (root -> containing folder) for an act id.
const findActFolderPath = (actId, bundles = allBundles, trail = []) => {
  for (const b of bundles) {
    if (!b) continue;
    const members = b.members || [];
    if (members.some((m) => m && m.ref === actId)) {
      return [...trail, b];
    }
    const nested = members.filter((m) => m && m.type === 'bundle');
    const found = findActFolderPath(actId, nested, [...trail, b]);
    if (found) return found;
  }
  return null;
};

// Small type-indicator icon for sidebar rows (folder vs. document).
const chipIcon = (kind) => {
  if (kind === 'bundle') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
};

// Render a breadcrumb (path of ancestors). Crumbs with a hash are links.
const renderBreadcrumb = (crumbs) => {
  if (!breadcrumbElement) return;
  breadcrumbElement.innerHTML = '';
  if (!Array.isArray(crumbs) || !crumbs.length) return;

  crumbs.forEach((crumb, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '\u203a';
      sep.setAttribute('aria-hidden', 'true');
      breadcrumbElement.appendChild(sep);
    }

    if (!crumb.hash) {
      const current = document.createElement('span');
      current.className = 'crumb is-current';
      current.textContent = crumb.label;
      breadcrumbElement.appendChild(current);
      return;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'crumb';
    btn.textContent = crumb.label;
    btn.addEventListener('click', () => {
      try {
        window.location.hash = crumb.hash;
      } catch (e) {
        window.location.href = `${window.location.pathname}${window.location.search}#${crumb.hash}`;
      }
    });
    breadcrumbElement.appendChild(btn);
  });
};

const buildEmptyState = () => {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';

  const icon = document.createElement('span');
  icon.className = 'empty-state-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>';
  wrap.appendChild(icon);

  const text = document.createElement('p');
  text.className = 'empty-state-text';
  text.textContent = 'Select a regulation to begin';
  wrap.appendChild(text);

  return wrap;
};

// Content-area skeleton: a title bar + a few paragraph blocks of shimmer lines.
const buildLoadingState = () => {
  const wrap = document.createElement('div');
  wrap.className = 'skeleton-article';
  wrap.setAttribute('aria-hidden', 'true');

  const title = document.createElement('div');
  title.className = 'skeleton skeleton-title';
  wrap.appendChild(title);

  for (let block = 0; block < 4; block += 1) {
    const para = document.createElement('div');
    para.className = 'skeleton-para';
    const lines = block % 2 === 0 ? 4 : 3;
    for (let i = 0; i < lines; i += 1) {
      const line = document.createElement('div');
      line.className = i === lines - 1 ? 'skeleton skeleton-line short' : 'skeleton skeleton-line';
      para.appendChild(line);
    }
    wrap.appendChild(para);
  }

  return wrap;
};

// Sidebar skeleton: shimmer rows standing in for the act/folder list.
const buildSidebarSkeleton = (count = 7) => {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    const li = document.createElement('li');
    li.className = 'skeleton-row';
    li.setAttribute('aria-hidden', 'true');
    const pill = document.createElement('span');
    pill.className = 'skeleton skeleton-pill';
    li.appendChild(pill);
    frag.appendChild(li);
  }
  return frag;
};

const renderArticleDetail = (article) => {
  hideLegalTooltipImmediate();

  if (!article) {
    if (currentSidebarSelectionKey && currentSidebarSelectionKey.startsWith('act:')) {
      const selectedActId = currentSidebarSelectionKey.slice(4);
      const selectedAct = allActs.find((item) => item.id === selectedActId);
      if (selectedAct) {
        renderAct(selectedAct);
        return;
      }
    }

    articleNumberElement.textContent = '';
    renderBreadcrumb([]);
    articleTitleElement.textContent = '';
    articleSubtitleElement.textContent = '';
    renderLegalEntityApplicability();
    paragraphsContainer.innerHTML = '';
    paragraphsContainer.appendChild(buildEmptyState());
    return;
  }

  const headingText = getHeadingText(article);
  const numberText = (article.title || article.id || '').trim();

  articleNumberElement.textContent = numberText;
  const parentAct = allActs.find((item) => item.id === article._actId);
  renderBreadcrumb(parentAct
    ? [{ label: parentAct.title || parentAct.id, hash: `act:${parentAct.id}` }]
    : []);
  articleTitleElement.textContent = headingText || numberText;
  attachHeadingTools(articleTitleElement, {
    getText: () => getArticleHeadingText(article),
    getLink: () => getArticlePermalink(article._actId || getCurrentActId(), article.id),
    getCitation: () => getArticleCitation(article, article._actId || getCurrentActId()),
  });
  articleSubtitleElement.textContent = '';
  renderLegalEntityApplicability();

  paragraphsContainer.innerHTML = '';
  const fragment = document.createDocumentFragment();

  (article.paragraphs || []).forEach((paragraph) => {
    const paragraphElement = createParagraphElement(paragraph, article);
    if (paragraphElement) {
      fragment.appendChild(paragraphElement);
    }
  });

  paragraphsContainer.appendChild(fragment);
  // Apply search highlighting for the current query
  highlightSearchMatches(lastSearchQuery);
};

// Render an item by type (act or bundle)
const renderItem = (item) => {
  if (!item) {
    renderArticleDetail(null);
    return;
  }

  if (item.type === 'bundle') {
    renderBundle(item);
    return;
  }

  if (item.type === 'act') {
    renderAct(item);
    return;
  }

  // Fallback: if item looks like an article, render it
  renderArticleDetail(item);
};

// Render an act-level object (may contain `articles` or `paragraphs`)
const renderAct = (act) => {
  hideLegalTooltipImmediate();

  if (!act) {
    renderArticleDetail(null);
    return;
  }

  articleNumberElement.textContent = '';
  renderBreadcrumb([]);
  articleTitleElement.textContent = act.title || act.id || '';
  attachHeadingTools(articleTitleElement, {
    getText: () => getActHeadingText(act),
    getLink: () => getActPermalink(act.id),
    getCitation: () => getActCitation(act),
  });
  articleSubtitleElement.textContent = [getSubtitleText(act), act.heading].filter(Boolean).join(' — ');
  renderLegalEntityApplicability(act.id);

  paragraphsContainer.innerHTML = '';
  const fragment = document.createDocumentFragment();

  // If act has articles, render each with heading then paragraphs
  if (Array.isArray(act.articles)) {
    act.articles.forEach((article) => {
      const h = document.createElement('h3');
      h.className = 'act-article-title';
      h.textContent = article.title || article.id || '';
      attachHeadingTools(h, {
        getText: () => getArticleHeadingText(article),
        getLink: () => getArticlePermalink(act.id, article.id),
        getCitation: () => getArticleCitation(article, act.id),
      });
      fragment.appendChild(h);

      (article.paragraphs || []).forEach((p) => {
        const paragraphElement = createParagraphElement(p, article);
        if (paragraphElement) {
          fragment.appendChild(paragraphElement);
        }
      });
    });
  } else if (Array.isArray(act.paragraphs)) {
    (act.paragraphs || []).forEach((p) => {
      const paragraphElement = createParagraphElement(p, act);
      if (paragraphElement) {
        fragment.appendChild(paragraphElement);
      }
    });
  }

  paragraphsContainer.appendChild(fragment);
  // Highlight search matches inside the act view as well
  highlightSearchMatches(lastSearchQuery);
};

// Render a bundle: title, description, and member list linking to acts
const renderBundle = (bundle) => {
  hideLegalTooltipImmediate();

  if (!bundle) {
    renderArticleDetail(null);
    return;
  }

  articleNumberElement.textContent = '';
  const bundlePath = findBundlePath(bundle.id) || [bundle];
  const ancestors = bundlePath.slice(0, -1);
  renderBreadcrumb(ancestors.map((b) => ({ label: b.title || b.id, hash: `bundle:${b.id}` })));
  articleTitleElement.textContent = bundle.title || bundle.id || '';
  attachHeadingTools(articleTitleElement, {
    getText: () => getBundleHeadingText(bundle),
    getLink: () => getBundlePermalink(bundle.id),
    getCitation: () => getBundleHeadingText(bundle),
  });
  articleSubtitleElement.textContent = '';
  renderLegalEntityApplicability(bundle.id);

  paragraphsContainer.innerHTML = '';
  const fragment = document.createDocumentFragment();

  if (bundle.description) {
    const p = document.createElement('p');
    p.className = 'bundle-description';
    p.textContent = bundle.description;
    fragment.appendChild(p);
  }

  if (Array.isArray(bundle.members) && bundle.members.length) {
    const list = document.createElement('ul');
    list.className = 'bundle-members';
    bundle.members.forEach((m) => {
      if (!m) {
        return;
      }
      const li = document.createElement('li');

      // Nested sub-folder: link expands it in the sidebar
      if (m.type === 'bundle') {
        const a = document.createElement('a');
        a.href = `#bundle:${m.id}`;
        a.textContent = m.title || m.id;
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          expandedBundleIds.add(m.id);
          renderArticleList();
          try {
            window.location.hash = `bundle:${m.id}`;
          } catch (e) {
            window.location.href = `${window.location.pathname}${window.location.search}#bundle:${m.id}`;
          }
        });
        li.appendChild(a);
        list.appendChild(li);
        return;
      }

      const a = document.createElement('a');
      a.href = `#act:${m.ref}`;
      a.textContent = m.label || m.ref;
      a.addEventListener('click', (ev) => {
        // set hash to act:<ID> and allow route handler to pick up
        ev.preventDefault();
        try {
          window.location.hash = `act:${m.ref}`;
        } catch (e) {
          window.location.href = `${window.location.pathname}${window.location.search}#act:${m.ref}`;
        }
      });
      li.appendChild(a);
      list.appendChild(li);
    });
    fragment.appendChild(list);
  }

  paragraphsContainer.appendChild(fragment);
  // highlight any query terms in the bundle view (applies to description)
  highlightSearchMatches(lastSearchQuery);
};

const renderArticleList = () => {
  // Only rebuild the sidebar when its structure changes; selection changes just
  // re-highlight in place so rows keep their transitions and scroll position.
  const signature = JSON.stringify([
    visibleSidebarItems.map(getSidebarItemKey),
    [...expandedBundleIds].sort(),
    lastSearchQuery,
  ]);
  if (signature !== lastSidebarSignature) {
    lastSidebarSignature = signature;
    renderSidebarList(visibleSidebarItems);
  } else {
    highlightActiveLink();
    updateCollapseAllButton();
  }
  syncActRowState();
  renderActPanel();
};

const getPanelActId = () => (expandedActIds.size ? [...expandedActIds][0] : null);

// Mark the act row whose articles are shown in the panel.
const syncActRowState = () => {
  const panelActId = getPanelActId();
  articleButtons.forEach((button, key) => {
    if (!key.startsWith('act:') || !button.classList.contains('opens-panel')) return;
    const open = key === `act:${panelActId}`;
    button.classList.toggle('is-expanded', open);
    button.setAttribute('aria-expanded', String(open));
  });
};

// Show the selected act's articles in a panel next to the sidebar.
const renderActPanel = () => {
  if (!actPanel || !layoutElement) return;

  const actId = getPanelActId();
  const act = actId ? allActs.find((a) => a.id === actId) : null;
  const articles = act && Array.isArray(act.articles)
    ? act.articles.filter((a) => a && a.id && (!lastSearchQuery || matchesItem(a, lastSearchQuery)))
    : [];
  const wasOpen = layoutElement.classList.contains('has-act-panel');
  const open = Boolean(act && articles.length);

  layoutElement.classList.toggle('has-act-panel', open);
  actPanel.setAttribute('aria-hidden', String(!open));
  actPanel.inert = !open;
  if (!open) {
    // Leave the old content in place so it is visible while the panel slides shut.
    highlightActiveLink();
    return;
  }

  const panelKey = `${act.id}|${lastSearchQuery}`;
  if (panelKey !== renderedPanelKey) {
    const switchingAct = wasOpen && renderedPanelKey && !renderedPanelKey.startsWith(`${act.id}|`);
    renderedPanelKey = panelKey;
    setListTitle(actPanelTitle, act);
    actPanelList.innerHTML = '';
    panelArticleButtons = new Map();

    const fragment = document.createDocumentFragment();
    articles.forEach((article) => {
      const rowItem = document.createElement('li');
      rowItem.className = 'act-panel-item';

      const rowButton = document.createElement('button');
      rowButton.type = 'button';
      rowButton.className = 'article-link article-child-link';

      const rowTitle = document.createElement('span');
      rowTitle.className = 'list-article-number';
      rowTitle.textContent = article.title || article.id;
      rowButton.appendChild(rowTitle);

      const rowHeading = getHeadingText(article);
      if (rowHeading) {
        const rowHeadingSpan = document.createElement('span');
        rowHeadingSpan.className = 'list-article-heading';
        rowHeadingSpan.textContent = rowHeading;
        rowButton.appendChild(rowHeadingSpan);
      }

      rowButton.addEventListener('click', (event) => {
        event.preventDefault();
        selectArticle(article.id, {
          updateHash: true,
          focus: false,
          parentActId: act.id,
          hashTarget: `a:${act.id}:${article.id}`,
        });
      });

      rowItem.appendChild(rowButton);
      panelArticleButtons.set(getArticleSelectionKey(article.id, act.id), rowButton);
      fragment.appendChild(rowItem);
    });
    actPanelList.appendChild(fragment);
    actPanel.scrollTop = 0;
    if (switchingAct) playEnterAnimation(actPanelList, 'is-entering');
  }

  highlightActiveLink();
};

const closeActPanel = () => {
  expandedActIds.clear();
  renderArticleList();
};

// Show the collapse-all control only when something is expanded
// (hidden during an active search).
const updateCollapseAllButton = () => {
  if (!collapseAllButton) return;
  const searchActive = Boolean(lastSearchQuery && lastSearchQuery.trim());
  const anyExpanded = expandedActIds.size > 0 || expandedBundleIds.size > 0;
  collapseAllButton.hidden = searchActive || !anyExpanded;
};

// Collapse every expanded folder and close the article panel
const collapseAll = () => {
  expandedActIds.clear();
  expandedBundleIds.clear();
  renderArticleList();
};

// Render the sidebar list with a small type chip and hash-based routing
const renderSidebarList = (items = []) => {
  articleButtons = new Map();

  // Adds a rotating disclosure chevron to expandable rows (folders / acts)
  const appendDisclosure = (btn, expanded) => {
    const chev = document.createElement('span');
    chev.className = 'disclosure';
    chev.setAttribute('aria-hidden', 'true');
    if (expanded) {
      btn.classList.add('is-expanded');
    }
    btn.appendChild(chev);
  };

  // Act rows open their article list in the panel next to the sidebar.
  const appendPanelDisclosure = (btn, act) => {
    if (!Array.isArray(act.articles) || !act.articles.length) return;
    btn.classList.add('opens-panel');
    appendDisclosure(btn, false);
  };

  const activateAct = (actId) => {
    setExpandedAct(actId, { allowCollapse: true });
    handleRoute(`act:${actId}`);
    updateLocationHash(`act:${actId}`);
  };

  // Toggle a folder, sliding its child list closed before it is removed.
  const toggleFolder = (folderId, button) => {
    if (expandedBundleIds.has(folderId)) {
      handleRoute(`bundle:${folderId}`);
      updateLocationHash(`bundle:${folderId}`);
      const childList = button.nextElementSibling;
      slideClosed(childList, () => {
        expandedBundleIds.delete(folderId);
        renderArticleList();
      });
      return;
    }
    expandedBundleIds.add(folderId);
    pendingFolderSlideId = folderId;
    renderArticleList();
    handleRoute(`bundle:${folderId}`);
    updateLocationHash(`bundle:${folderId}`);
  };

  let folderListToSlide = null;

  // Build an act row nested inside a folder; its articles open in the side panel.
  const createNestedActRow = (act) => {
    const actItem = document.createElement('li');
    actItem.className = 'act-article-list-item';

    const actButton = document.createElement('button');
    actButton.type = 'button';
    actButton.className = 'article-link article-child-link';

    const actTitle = document.createElement('span');
    actTitle.className = 'list-article-number';
    setListTitle(actTitle, act);
    actButton.appendChild(actTitle);

    const actSubtitleText = getSubtitleText(act);
    if (actSubtitleText) {
      const actSubtitleSpan = document.createElement('span');
      actSubtitleSpan.className = 'list-article-subtitle';
      actSubtitleSpan.textContent = actSubtitleText;
      actButton.appendChild(actSubtitleSpan);
    }

    const actHeadingText = getHeadingText(act);
    if (actHeadingText) {
      const actHeadingSpan = document.createElement('span');
      actHeadingSpan.className = 'list-article-heading';
      actHeadingSpan.textContent = actHeadingText;
      actButton.appendChild(actHeadingSpan);
    }

    appendPanelDisclosure(actButton, act);

    actButton.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      activateAct(act.id);
    });

    actItem.appendChild(actButton);
    articleButtons.set(`act:${act.id}`, actButton);

    return actItem;
  };

  // Build a sub-folder row that recursively renders its own children.
  const createFolderRow = (folder) => {
    const subItem = document.createElement('li');
    subItem.className = 'act-article-list-item';

    const subButton = document.createElement('button');
    subButton.type = 'button';
    subButton.className = 'article-link article-child-link';

    const subChip = document.createElement('span');
    subChip.className = 'item-chip bundle';
        subChip.innerHTML = chipIcon('bundle');
    const subTitle = document.createElement('span');
    subTitle.className = 'list-article-number';
    subTitle.textContent = folder.title || folder.id;
    subButton.appendChild(subTitle);

    appendDisclosure(subButton, expandedBundleIds.has(folder.id));

    subButton.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleFolder(folder.id, subButton);
    });

    subItem.appendChild(subButton);
    articleButtons.set(getSidebarItemKey(folder), subButton);

    if (expandedBundleIds.has(folder.id)) {
      const childList = buildMemberList(folder);
      let childElement = childList;
      if (!childElement) {
        childElement = document.createElement('p');
        childElement.className = 'folder-empty-note';
        childElement.textContent = 'No regulations yet';
      }
      subItem.appendChild(childElement);
      if (folder.id === pendingFolderSlideId) folderListToSlide = childElement;
    }

    return subItem;
  };

  // Recursively build a folder's children: nested sub-folders and member acts.
  function buildMemberList(bundleItem) {
    const members = Array.isArray(bundleItem.members) ? bundleItem.members : [];
    if (!members.length) {
      return null;
    }

    const list = document.createElement('ul');
    list.className = 'act-article-list bundle-child-acts';
    let rendered = 0;

    members.forEach((member) => {
      if (member && member.type === 'bundle') {
        list.appendChild(createFolderRow(member));
        rendered += 1;
        return;
      }

      const act = member && member.ref ? allActs.find((a) => a.id === member.ref) : null;
      if (!act) {
        return;
      }
      list.appendChild(createNestedActRow(act));
      rendered += 1;
    });

    return rendered ? list : null;
  }

  // Save current scroll position and the list's offset so we can compensate
  // for anything above it (collapse button / message) toggling on re-render.
  const savedScrollPosition = sidePanel ? sidePanel.scrollTop : 0;
  const listOffsetBefore = articleListElement.offsetTop;

  articleListElement.innerHTML = '';

  if (!items.length) {
    updateListMessage();
    return;
  }

  const fragment = document.createDocumentFragment();

  items.forEach((item) => {
    const listItem = document.createElement('li');
    listItem.className = 'article-list-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'article-link';

    // Determine kind for chip and target hash
    const kind = item.type === 'bundle' ? 'bundle' : 'act';

    const chip = document.createElement('span');
    chip.className = 'item-chip';
    chip.classList.add(kind);
    chip.innerHTML = chipIcon(kind);
    button.appendChild(chip);

    const numberSpan = document.createElement('span');
    numberSpan.className = 'list-article-number';
    setListTitle(numberSpan, item);
    button.appendChild(numberSpan);

    const headingText = getHeadingText(item);
    if (headingText) {
      const headingSpan = document.createElement('span');
      headingSpan.className = 'list-article-heading';
      headingSpan.textContent = headingText;
      button.appendChild(headingSpan);
    }

    if (item.type === 'bundle') {
      appendDisclosure(button, expandedBundleIds.has(item.id));
    } else {
      appendPanelDisclosure(button, item);
    }

    button.addEventListener('click', () => {
      if (item.type === 'bundle') {
        toggleFolder(item.id, button);
        return;
      }
      activateAct(item.id);
    });

    listItem.appendChild(button);

    // Bundle: render members (nested sub-folders and acts) as expandable children
    if (item.type === 'bundle' && expandedBundleIds.has(item.id)) {
      const memberList = buildMemberList(item);
      if (memberList) {
        listItem.appendChild(memberList);
        if (item.id === pendingFolderSlideId) folderListToSlide = memberList;
      }
    }

    fragment.appendChild(listItem);

    // Keep reference for potential highlighting (legacy behavior)
    articleButtons.set(getSidebarItemKey(item), button);
  });

  articleListElement.appendChild(fragment);
  pendingFolderSlideId = null;
  slideOpen(folderListToSlide);
  updateListMessage();
  highlightActiveLink();
  updateCollapseAllButton();
  if (sidePanel) {
    // Restore scroll synchronously, before the browser paints, so the full
    // list rebuild never yanks the panel to a different position (the previous
    // rAF restore painted at the wrong scroll first, causing a visible jump).
    // Adjust by the list's offset delta so a collapse button / message that
    // appears or disappears above the list doesn't shift the rows either.
    const listOffsetDelta = articleListElement.offsetTop - listOffsetBefore;
    sidePanel.scrollTop = savedScrollPosition + listOffsetDelta;

    // After layout settles, only nudge the active item into view if it ended up
    // outside the panel (e.g. breadcrumb, hash link, or keyboard navigation).
    requestAnimationFrame(() => {
      const activeKey = currentSidebarSelectionKey;
      const activeButton = activeKey ? articleButtons.get(activeKey) : null;
      if (activeButton) {
        const panelRect = sidePanel.getBoundingClientRect();
        const itemRect = activeButton.getBoundingClientRect();
        // Only pull the active item in when it's entirely out of view (e.g. hash
        // or keyboard navigation). If any part is already visible — like the row
        // the user just clicked — leave the scroll alone to avoid a jump.
        if (itemRect.bottom <= panelRect.top || itemRect.top >= panelRect.bottom) {
          activeButton.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        }
      }
    });
  }
};

const selectArticle = (articleId, options = {}) => {
  if (!articleId) {
    currentArticleId = null;
    currentArticleSelectionKey = null;
    currentSidebarSelectionKey = null;
    renderArticleDetail(null);
    clearParagraphHighlight();
    updateNavigationButtons();
    updateStatus();
    highlightActiveLink();
    return;
  }

  const preferredParentActId = options.parentActId || null;
  const article = preferredParentActId
    ? allArticles.find((item) => item.id === articleId && item._actId === preferredParentActId)
    : allArticles.find((item) => item.id === articleId);
  if (!article) {
    return;
  }

  const parentActId = preferredParentActId || article._actId || article.id;
  const previousArticleSelectionKey = currentArticleSelectionKey;
  currentArticleSelectionKey = getArticleSelectionKey(article.id, parentActId);
  const hasParentAct = allActs.some((act) => act.id === parentActId);
  currentSidebarSelectionKey = hasParentAct ? `act:${parentActId}` : null;
  if (hasParentAct) {
    (findActFolderPath(parentActId) || []).forEach((b) => expandedBundleIds.add(b.id));
    setExpandedAct(parentActId);
    renderArticleList();
  }

  if (!visibleArticles.some((item) => item.id === articleId)) {
    visibleArticles = [...allArticles];
    searchInput.value = '';
    renderArticleList();
  }

  currentArticleId = articleId;
  renderArticleDetail(article);
  if (previousArticleSelectionKey !== currentArticleSelectionKey) {
    playEnterAnimation(articleContentElement, 'is-entering');
  }

  const targetParagraphId = options.targetParagraphId || null;
  let hashTarget = options.hashTarget || null;
  let paragraphHighlighted = false;

  if (targetParagraphId) {
    paragraphHighlighted = highlightParagraph(targetParagraphId, {
      behavior: options.highlightBehavior || 'smooth',
      focus: options.focusParagraph !== false,
    });
    if (!hashTarget) {
      hashTarget = paragraphHighlighted ? targetParagraphId : articleId;
    }
  } else {
    clearParagraphHighlight();
    if (!hashTarget) {
      hashTarget = articleId;
    }
  }

  highlightActiveLink();
  updateNavigationButtons();
  updateStatus();

  const button = panelArticleButtons.get(currentArticleSelectionKey) || articleButtons.get(getArticleSelectionKey(articleId));
  if (button && options.scrollIntoView !== false) {
    button.scrollIntoView({ block: 'nearest' });
  }

  if (options.updateHash !== false) {
    updateLocationHash(hashTarget || articleId);
  }

  if (options.focus !== false && !targetParagraphId) {
    try {
      articleTitleElement.focus({ preventScroll: true });
    } catch (error) {
      articleTitleElement.focus();
    }
  }
};

const handleHashNavigation = (hashId, options = {}) => {
  if (!hashId) {
    return false;
  }

  const { behavior = 'smooth', scrollIntoView = true, focusParagraph = true } = options;
  const { articleId, paragraphId, parentActId } = parseHashTarget(hashId);

  if (!articleId) {
    return false;
  }

  selectArticle(articleId, {
    updateHash: false,
    focus: !paragraphId,
    scrollIntoView,
    targetParagraphId: paragraphId,
    highlightBehavior: behavior,
    focusParagraph,
    parentActId,
  });

  return true;
};

// Unified route handler: supports `act:<ID>`, `bundle:<ID>`, and legacy article ids
const handleRoute = (hashId) => {
  const raw = `${hashId || ''}`.trim();

  if (!raw) {
    return false;
  }

  // act:<ID>
  if (raw.startsWith('act:')) {
    const id = raw.slice(4);
    const act = allActs.find((a) => a.id === id);
    if (!act) {
      statusMessage.textContent = `Act ${id} not found.`;
      return true;
    }
    const changedSelection = currentSidebarSelectionKey !== `act:${id}`;
    // Expand the folder chain that contains this act so it shows on the left.
    const folderPath = findActFolderPath(id) || [];
    folderPath.forEach((b) => expandedBundleIds.add(b.id));
    if (changedSelection) setExpandedAct(id);
    // render act-level view
    renderItem(act);
    currentSidebarSelectionKey = `act:${id}`;
    currentArticleSelectionKey = null;
    // clear article selection state
    currentArticleId = null;
    renderArticleList();
    updateNavigationButtons();
    updateStatus();
    // Show a newly opened act from the top (also fixes the initial load offset).
    if (changedSelection) {
      window.scrollTo({ top: 0 });
      playEnterAnimation(articleContentElement, 'is-entering');
    }
    return true;
  }

  // bundle:<ID>
  if (raw.startsWith('bundle:')) {
    const id = raw.slice(7);
    const bundle = findBundleById(id);
    if (!bundle) {
      statusMessage.textContent = `Bundle ${id} not found.`;
      return true;
    }
    // Expand the containing folders so the sidebar reflects where we are.
    const ancestors = (findBundlePath(id) || [bundle]).slice(0, -1);
    ancestors.forEach((b) => expandedBundleIds.add(b.id));
    const changedSelection = currentSidebarSelectionKey !== `bundle:${id}`;
    if (changedSelection) expandedActIds.clear();
    renderItem(bundle);
    currentSidebarSelectionKey = `bundle:${id}`;
    currentArticleSelectionKey = null;
    currentArticleId = null;
    renderArticleList();
    updateNavigationButtons();
    updateStatus();
    if (changedSelection) {
      window.scrollTo({ top: 0 });
      playEnterAnimation(articleContentElement, 'is-entering');
    }
    return true;
  }

  // Fallback to legacy article/paragraph handling
  return handleHashNavigation(raw, { behavior: 'auto', scrollIntoView: true, focusParagraph: false });
};

const handleInternalLinkClick = (event) => {
  const link = event.target.closest('a.ref, a.internal-article-link');
  if (!link) {
    return;
  }

  // Cross-act reference: resolve the id to a hosted act, else fall through
  // and let the anchor's external href open in a new tab.
  const refId = refIdOf(link);
  if (refId) {
    const targetActId = authToActId[refId];
    if (!targetActId) {
      return;
    }
    event.preventDefault();
    const articleAttr = link.dataset.article;
    if (articleAttr) {
      const articleId = artIdOf(articleAttr);
      selectArticle(articleId, {
        updateHash: false,
        focus: true,
        parentActId: targetActId,
      });
      updateLocationHash(`a:${targetActId}:${articleId}`);
    } else {
      handleRoute(`act:${targetActId}`);
      updateLocationHash(`act:${targetActId}`);
    }
    return;
  }

  // Same-act (or legacy) reference: an in-app hash target.
  const href = link.getAttribute('href') || '';
  if (!href.startsWith('#')) {
    return;
  }

  event.preventDefault();

  const targetId = href.slice(1);
  const { articleId, paragraphId, parentActId } = parseHashTarget(targetId);

  if (!articleId) {
    return;
  }

  const scopedParentActId = parentActId || getCurrentActId();

  selectArticle(articleId, {
    updateHash: false,
    focus: !paragraphId,
    targetParagraphId: paragraphId,
    parentActId: scopedParentActId,
  });

  const hashTarget = scopedParentActId
    ? `a:${scopedParentActId}:${paragraphId || articleId}`
    : (paragraphId || articleId);
  updateLocationHash(hashTarget);
};

const goToPrevious = () => {
  const index = getCurrentIndex();
  if (index > 0) {
    selectArticle(visibleArticles[index - 1].id);
  }
};

const goToNext = () => {
  const index = getCurrentIndex();
  if (index !== -1 && index < visibleArticles.length - 1) {
    selectArticle(visibleArticles[index + 1].id);
  }
};

// Returns true if the given item (article-like or bundle) matches the query
const matchesItem = (item, query) => {
  const q = normaliseForSearch(`${query || ''}`.trim());
  if (!q) return true;

  if (item && item.type === 'bundle') {
    const title = normaliseForSearch(item.title || '');
    const desc = normaliseForSearch(item.description || '');
    const membersText = (item.members || [])
      .map((m) => ((m && (m.label || m.title || m.ref)) || ''))
      .join(' ')
      .replace(/<[^>]*>/g, ' ');
    const normalisedMembersText = normaliseForSearch(membersText);

    return title.includes(q) || desc.includes(q) || normalisedMembersText.includes(q);
  }

  if (item && item.type === 'act') {
    const title = normaliseForSearch(item.title || '');
    const heading = normaliseForSearch(getHeadingText(item));
    const subtitle = normaliseForSearch(getSubtitleText(item));
    const articleText = (item.articles || [])
      .map((article) => {
        const articleTitle = normaliseForSearch(article?.title || '');
        const paragraphs = (article?.paragraphs || [])
          .map((paragraph) => {
            if (!paragraph) return '';
            if (typeof paragraph === 'string') return stripHtml(paragraph);
            return stripHtml(paragraph.text || '');
          })
          .join(' ')
          .replace(/\s+/g, ' ');
        const normalisedParagraphs = normaliseForSearch(paragraphs);
        return `${articleTitle} ${normalisedParagraphs}`;
      })
      .join(' ')
      .replace(/\s+/g, ' ');
    const normalisedArticleText = normaliseForSearch(articleText);

    const paragraphs = (item.paragraphs || [])
      .map((paragraph) => {
        if (!paragraph) return '';
        if (typeof paragraph === 'string') return stripHtml(paragraph);
        return stripHtml(paragraph.text || '');
      })
      .join(' ')
      .replace(/\s+/g, ' ');
    const normalisedParagraphs = normaliseForSearch(paragraphs);

    return title.includes(q) || heading.includes(q) || subtitle.includes(q) || normalisedArticleText.includes(q) || normalisedParagraphs.includes(q);
  }

  // Treat as article-like
  const title = normaliseForSearch(item.title || '');
  const heading = normaliseForSearch(getHeadingText(item));
  const summary = normaliseForSearch(getSummaryText(item));
  const paragraphs = (item.paragraphs || [])
    .map((paragraph) => {
      if (!paragraph) return '';
      if (typeof paragraph === 'string') return stripHtml(paragraph);
      return stripHtml(paragraph.text || '');
    })
    .join(' ')
    .replace(/\s+/g, ' ');
  const normalisedParagraphs = normaliseForSearch(paragraphs);

  return title.includes(q) || heading.includes(q) || summary.includes(q) || normalisedParagraphs.includes(q);
};

const applyFilter = (query) => {
  const normalisedQuery = `${query || ''}`.trim().toLowerCase();
  lastSearchQuery = normalisedQuery;

  if (!normalisedQuery) {
    visibleSidebarItems = allSidebarItems.slice();
  } else {
    visibleSidebarItems = allActs.filter((item) => matchesItem(item, normalisedQuery)).sort(compareByTitle);
  }

  renderArticleList();

  if (!visibleSidebarItems.length) {
    currentArticleId = null;
    currentSidebarSelectionKey = null;
    renderArticleDetail(null);
    updateNavigationButtons();
    updateStatus();
    highlightActiveLink();
    return;
  }

  const hasVisibleSelectedSidebarItem = visibleSidebarItems.some((item) => getSidebarItemKey(item) === currentSidebarSelectionKey);

  if (!hasVisibleSelectedSidebarItem) {
    const first = visibleSidebarItems[0];
    if (first.type === 'bundle') {
      try {
        window.location.hash = `bundle:${first.id}`;
      } catch (e) {
        window.location.href = `${window.location.pathname}${window.location.search}#bundle:${first.id}`;
      }
    } else if (first.type === 'act') {
      try {
        window.location.hash = `act:${first.id}`;
      } catch (e) {
        window.location.href = `${window.location.pathname}${window.location.search}#act:${first.id}`;
      }
    } else {
      selectArticle(first.id, { updateHash: true, focus: false });
    }
  } else {
    updateNavigationButtons();
    updateStatus();
  }

  // Always refresh highlights in the currently rendered view so typing
  // or deleting characters updates visible highlights immediately.
  highlightSearchMatches(lastSearchQuery);
};

let searchDebounceTimer = null;

const handleSearchInput = (event) => {
  const value = event.target.value;
  window.clearTimeout(searchDebounceTimer);

  // Clearing the field should feel instant; typing is debounced.
  if (!value.trim()) {
    applyFilter(value);
    return;
  }

  searchDebounceTimer = window.setTimeout(() => {
    applyFilter(value);
  }, 180);
};

const clearSearch = () => {
  if (searchInput.value) {
    searchInput.value = '';
  }
  applyFilter('');
  searchInput.focus();
};

// Load registry listing acts and bundles
const loadRegistry = async () => {
  const res = await fetch('data/index.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to load registry: ${res.status}`);
  }
  return res.json();
};

// Lightweight CELEX metadata generated by tools/build_index_db.py.
const loadIndexMeta = async () => {
  const res = await fetch('data/index_meta.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to load index meta: ${res.status}`);
  }
  return res.json();
};

const loadLegalEntityApplicability = async () => {
  const res = await fetch('data/legal_entity_applicability.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to load legal entity applicability: ${res.status}`);
  }
  return res.json();
};

// Load each act and bundle referenced by the registry. Returns { acts, bundles }.
const loadAllData = async () => {
  const registry = await loadRegistry();

  legalEntitiesByItemId = {};
  try {
    const applicability = await loadLegalEntityApplicability();
    legalEntitiesByItemId = {
      ...((applicability && applicability.actEntities) || {}),
      ...((applicability && applicability.bundleEntities) || {}),
      ...((applicability && applicability.familyEntities) || {}),
    };
  } catch (error) {
    console.warn('Legal entity applicability is unavailable:', error);
  }

  // Scheme-qualified id -> app act id: the runtime bridge for cross-act references.
  // data/index.json remains the source of truth for app content; index_meta.json is
  // just a compact id->celex map for this runtime lookup.
  authToActId = {};
  try {
    const indexMeta = await loadIndexMeta();
    const idToCelex = (indexMeta && indexMeta.idToCelex) || {};
    Object.entries(idToCelex).forEach(([id, celex]) => {
      if (!id || !celex) return;
      authToActId[`celex:${celex}`] = id;
    });
  } catch (error) {
    console.warn('Falling back to registry authId map:', error);
    (registry.acts || []).forEach((entry) => {
      if (!entry) return;
      if (entry.authId) {
        authToActId[entry.authId] = entry.id;
      } else if (entry.celex) {
        authToActId[`celex:${entry.celex}`] = entry.id;   // legacy registry entries
      }
    });
  }

  const acts = [];
  const bundles = [];

  const actFetches = (registry.acts || []).map(async (entry) => {
    const res = await fetch(entry.path, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Failed to fetch act ${entry.id} (${entry.path}): ${res.status}`);
    }
    const json = await res.json();

    if (Array.isArray(json)) {
      acts.push({
        type: 'act',
        id: entry.id,
        title: entry.label || entry.id,
        heading: entry.heading || '',
        source: {
          uri: '',
          label: 'EUR-Lex',
        },
        meta: {
          jurisdiction: entry.jurisdiction || 'EU',
        },
        articles: json,
      });
      return;
    }

    if (!json || json.type !== 'act') {
      console.warn('Skipped non-act file', entry);
      return;
    }

    // Keep the raw act-level object for renderAct
    acts.push(json);
  });

  const bundleFetches = (registry.bundles || []).map(async (entry) => {
    const res = await fetch(entry.path, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Failed to fetch bundle ${entry.id} (${entry.path}): ${res.status}`);
    }
    const json = await res.json();
    if (!json || json.type !== 'bundle') {
      console.warn('Skipped non-bundle file', entry);
      return;
    }
    bundles.push(json);
  });

  await Promise.all([...actFetches, ...bundleFetches]);

  // Flatten acts into article-level entries for the sidebar/list UI
  const flattenedArticles = [];
  acts.forEach((act) => {
    if (Array.isArray(act.articles)) {
      act.articles.forEach((a) => {
        const article = Object.assign({}, a);
        // link back to parent act
        article._actId = act.id || null;
        article._actTitle = act.title || '';
        flattenedArticles.push(article);
      });
    } else if (Array.isArray(act.paragraphs)) {
      const article = {
        id: act.id,
        title: act.title || act.id,
        heading: act.heading || '',
        paragraphs: act.paragraphs,
        _actId: act.id,
        _actTitle: act.title || '',
      };
      flattenedArticles.push(article);
    }
  });

  return { acts, bundles, articles: flattenedArticles };
};

const fetchArticles = async () => {
  const articleContent = document.querySelector('.article-content');
  if (articleContent) articleContent.classList.add('is-loading');
  if (articleNav) articleNav.hidden = true;
  listMessage.textContent = '';
  if (articleListElement) {
    articleListElement.innerHTML = '';
    articleListElement.appendChild(buildSidebarSkeleton());
  }
  if (paragraphsContainer) {
    paragraphsContainer.innerHTML = '';
    paragraphsContainer.appendChild(buildLoadingState());
  }

  try {
    const { acts, bundles, articles } = await loadAllData();

    allActs = acts;
    allBundles = bundles;

    // Maintain the old `allArticles` array used by the UI by using the flattened articles
    allArticles = Array.isArray(articles) ? articles : [];

    // Acts that live inside a folder are shown within that folder only, not
    // duplicated as top-level sidebar entries.
    const collectBundleActRefs = (bundleList, acc = new Set()) => {
      (bundleList || []).forEach((b) => {
        (b && b.members || []).forEach((m) => {
          if (!m) return;
          if (m.type === 'bundle') collectBundleActRefs([m], acc);
          else if (m.ref) acc.add(m.ref);
        });
      });
      return acc;
    };
    const foldered = collectBundleActRefs(allBundles);
    const topLevelActs = allActs.filter((a) => !foldered.has(a.id));

    // Folders first (alphabetical), then acts (alphabetical).
    allSidebarItems = [
      ...allBundles.slice().sort(compareByTitle),
      ...topLevelActs.sort(compareByTitle),
    ];
    expandedActIds = new Set();
    expandedBundleIds = new Set();
    lastSidebarSignature = null;

    if (!allSidebarItems.length) {
      statusMessage.textContent = 'No acts available at this time.';
      listMessage.textContent = 'No acts available at this time.';
      renderArticleDetail(null);
      updateNavigationButtons();
      return;
    }

    visibleArticles = [...allArticles];
    visibleSidebarItems = [...allSidebarItems];
    renderArticleList();

    const hashId = window.location.hash ? window.location.hash.replace('#', '') : '';
    const handled = handleRoute(hashId);

    if (!handled) {
      // Default to first act if available
      const firstActId = allActs?.[0]?.id;
      if (firstActId) {
        try {
          window.location.hash = `act:${firstActId}`;
        } catch (e) {
          window.location.href = `${window.location.pathname}${window.location.search}#act:${firstActId}`;
        }
      } else {
        // Fallback: select first flattened article
        const fallbackId = visibleArticles[0]?.id;
        if (fallbackId) {
          selectArticle(fallbackId, {
            updateHash: false,
            focus: false,
          });
        }
      }
    }

    updateStatus();
  } catch (error) {
    console.error('Failed to load data', error);
    statusMessage.textContent = 'We were unable to load the data. Please try again later.';
    listMessage.textContent = 'Unable to load articles.';
    renderArticleDetail(null);
    updateNavigationButtons();
  } finally {
    if (articleContent) articleContent.classList.remove('is-loading');
  }
};

searchInput.addEventListener('input', handleSearchInput);
prevButton.addEventListener('click', goToPrevious);
nextButton.addEventListener('click', goToNext);
if (collapseAllButton) {
  collapseAllButton.addEventListener('click', collapseAll);
}
if (actPanelClose) {
  actPanelClose.addEventListener('click', closeActPanel);
}

const pageHeader = document.getElementById('pageHeader');
const headerToggle = document.getElementById('headerToggle');
if (pageHeader && headerToggle) {
  headerToggle.addEventListener('click', () => {
    const collapsed = pageHeader.classList.toggle('is-collapsed');
    headerToggle.setAttribute('aria-expanded', String(!collapsed));
    headerToggle.setAttribute('aria-label', collapsed ? 'Expand header' : 'Collapse header');
  });
}

window.addEventListener('hashchange', () => {
  if (isUpdatingHash) {
    isUpdatingHash = false;
    return;
  }

  const hashId = window.location.hash ? window.location.hash.replace('#', '') : '';
  // delegate to unified route handler
  handleRoute(hashId);
});

// Don't let the browser restore a previous scroll position on load.
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

document.addEventListener('DOMContentLoaded', fetchArticles);

initialiseLegalTooltips();
document.addEventListener('click', handleInternalLinkClick);

const copyToClipboard = async (value) => {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (error) {
    // Intentionally fall through to legacy fallback.
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);

  let copied = false;
  try {
    textarea.select();
    copied = document.execCommand('copy');
  } catch (error) {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
};

// Inline SVG icons for the copy tools (Feather/Lucide, 24x24 stroke).
const TOOL_SVG = (inner) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;

const TOOL_ICONS = {
  text: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>',
  citation: '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"></path><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"></path>',
  success: '<polyline points="20 6 9 17 4 12"></polyline>',
  error: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
};

const showCopyConfirmation = (button, label, { isSuccess = true } = {}) => {
  if (!button) {
    return;
  }

  if (button.dataset.originalHtml === undefined) {
    button.dataset.originalHtml = button.innerHTML;
  }

  if (button._copyTimeoutId) {
    clearTimeout(button._copyTimeoutId);
    button._copyTimeoutId = null;
  }

  button.innerHTML = TOOL_SVG(isSuccess ? TOOL_ICONS.success : TOOL_ICONS.error);
  if (isSuccess) {
    button.classList.add('is-copied');
    button.classList.remove('has-copy-error');
  } else {
    button.classList.add('has-copy-error');
    button.classList.remove('is-copied');
  }

  button._copyTimeoutId = window.setTimeout(() => {
    button.innerHTML = button.dataset.originalHtml;
    button.classList.remove('is-copied');
    button.classList.remove('has-copy-error');
    button._copyTimeoutId = null;
  }, 1400);
};

const parseParagraphToken = (token = '') => {
  const trimmed = token.trim();
  if (!trimmed) {
    return { value: '', suffix: '' };
  }

  const match = trimmed.match(/^p?(\d+)([a-z]*)$/i);
  if (!match) {
    return { value: trimmed, suffix: '' };
  }

  const [, digits, suffix] = match;
  return { value: digits, suffix: suffix.toLowerCase() };
};

const formatParagraphDescriptor = (paragraphId) => {
  if (!paragraphId) {
    return '';
  }

  const [, detail] = paragraphId.split('__');
  if (!detail) {
    return '';
  }

  const segments = detail.split('_').filter(Boolean);
  if (!segments.length) {
    return '';
  }

  const [{ value: primaryValue, suffix: primarySuffix }] = [parseParagraphToken(segments[0])];
  if (!primaryValue) {
    return '';
  }

  const descriptorParts = [`paragraph ${primaryValue}`];
  if (primarySuffix) {
    descriptorParts.push(`(${primarySuffix})`);
  }

  segments.slice(1).forEach((segment) => {
    const { value, suffix } = parseParagraphToken(segment);
    if (value) {
      const suffixPortion = suffix ? ` ${suffix}` : '';
      descriptorParts.push(`(${value}${suffixPortion})`);
    } else {
      descriptorParts.push(`(${segment})`);
    }
  });

  return descriptorParts.join(' ');
};

const getParagraphCitation = (article, paragraphData) => {
  const articleTitle = (article?.title || article?.id || '').trim();
  const actId = article?._actId || getCurrentActId();
  const act = allActs.find((item) => item.id === actId);
  const regulationName = (act?.title || '').trim();

  const paragraphId = typeof paragraphData === 'object' ? (paragraphData?.id || '') : '';
  const paragraphDescriptor = formatParagraphDescriptor(paragraphId);
  const baseCitation = [regulationName, articleTitle].filter(Boolean).join(' ');

  return paragraphDescriptor
    ? `${baseCitation}, ${paragraphDescriptor}`
    : baseCitation;
};

const getParagraphPlainText = (paragraphElement) => {
  if (!paragraphElement) {
    return '';
  }

  const clone = paragraphElement.cloneNode(true);
  clone.querySelectorAll('.paragraph-tools').forEach((node) => node.remove());

  return clone.textContent
    .replace(/\s+\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
};

const buildPermalink = (hash) => {
  try {
    return new URL(`#${hash}`, window.location.href).href;
  } catch (error) {
    return `${window.location.origin}${window.location.pathname}${window.location.search}#${hash}`;
  }
};

const getParagraphPermalink = (paragraphId) => {
  if (!paragraphId) {
    return window.location.href;
  }

  // Scope the permalink to the act currently being viewed so the same paragraph
  // id shared across multiple acts (e.g. "art_6") resolves to the correct one
  // when the link is opened in a new tab.
  const currentActId = currentSidebarSelectionKey && currentSidebarSelectionKey.startsWith('act:')
    ? currentSidebarSelectionKey.slice(4)
    : null;
  return buildPermalink(currentActId ? `a:${currentActId}:${paragraphId}` : paragraphId);
};

const getArticlePermalink = (actId, articleId) =>
  buildPermalink(actId ? `a:${actId}:${articleId}` : articleId);

const getActPermalink = (actId) => buildPermalink(`act:${actId}`);

const getArticleHeadingText = (article) =>
  [article?.title, getHeadingText(article)].filter(Boolean).join(' — ').trim();

const getArticleCitation = (article, actId) => {
  const act = allActs.find((item) => item.id === actId);
  const regulationName = (act?.title || '').trim();
  const articleTitle = (article?.title || article?.id || '').trim();
  return [regulationName, articleTitle].filter(Boolean).join(' ');
};

const getActHeadingText = (act) =>
  [act?.title, act?.heading].filter(Boolean).join(' — ').trim();

const getActCitation = (act) => (act?.title || act?.id || '').trim();

const getBundlePermalink = (bundleId) => buildPermalink(`bundle:${bundleId}`);

const getBundleHeadingText = (bundle) => (bundle?.title || bundle?.id || '').trim();


// --- Search highlighting helpers ---
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const removeExistingHighlights = (container) => {
  if (!container) return;
  const marks = container.querySelectorAll('mark.search-hit');
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
};

const highlightMatchesInNode = (node, regex) => {
  if (!node || node.nodeType === Node.COMMENT_NODE) return;

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue;
    const match = regex.exec(text);
    if (!match) return;

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const before = text.slice(lastIndex, m.index);
      if (before) frag.appendChild(document.createTextNode(before));
      const mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.textContent = m[0];
      frag.appendChild(mark);
      lastIndex = m.index + m[0].length;
      if (m[0].length === 0) break; // avoid infinite loop
    }
    const after = text.slice(lastIndex);
    if (after) frag.appendChild(document.createTextNode(after));
    node.parentNode.replaceChild(frag, node);
    return;
  }

  // Do not descend into paragraph tools or existing marks
  if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'mark' || node.classList.contains('paragraph-tools')) return;
    // copy childNodes into array because live NodeList will change
    const children = Array.from(node.childNodes);
    children.forEach((child) => highlightMatchesInNode(child, regex));
  }
};

const highlightSearchMatches = (query) => {
  const container = paragraphsContainer;
  if (!container) return;
  removeExistingHighlights(container);

  const q = `${query || ''}`.trim();
  if (!q) return;

  // Use the whole query as a contiguous phrase so typing/removing letters
  // updates highlights exactly for the current input string.
  const phrase = q; // already trimmed
  if (!phrase) return;

  const pattern = escapeRegExp(phrase);
  let regex;
  try {
    regex = new RegExp(pattern, 'gi');
  } catch (e) {
    return;
  }

  // Highlight in paragraphs and bundle descriptions
  const paragraphs = container.querySelectorAll('.article-paragraph, .bundle-description');
  paragraphs.forEach((p) => {
    highlightMatchesInNode(p, regex);
  });

  // Highlight in article number, title, and subtitle
  [articleNumberElement, articleTitleElement, articleSubtitleElement].forEach((el) => {
    if (el && el.textContent) {
      // Remove previous highlights
      removeExistingHighlights(el);
      highlightMatchesInNode(el, regex);
    }
  });
};

const createToolsWrapper = (actions, ariaLabel = 'Tools') => {
  const toolsWrapper = document.createElement('span');
  toolsWrapper.className = 'paragraph-tools';
  toolsWrapper.setAttribute('role', 'group');
  toolsWrapper.setAttribute('aria-label', ariaLabel);

  actions.forEach((action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'paragraph-tool-button';
    button.innerHTML = TOOL_SVG(TOOL_ICONS[action.key] || '');
    button.title = action.label;
    button.setAttribute('aria-label', action.ariaLabel);

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const content = action.getContent();
      if (!content) {
        showCopyConfirmation(button, 'Error', { isSuccess: false });
        return;
      }

      const succeeded = await copyToClipboard(content);
      showCopyConfirmation(button, succeeded ? 'Copied' : 'Error', { isSuccess: succeeded });
    });

    toolsWrapper.appendChild(button);
  });

  return toolsWrapper;
};

const attachParagraphTools = (paragraphElement, article, paragraphData) => {
  if (!paragraphElement || typeof paragraphData !== 'object') {
    return;
  }

  const paragraphId = paragraphData.id || paragraphElement.id;
  if (!paragraphId) {
    return;
  }

  paragraphElement.classList.add('has-paragraph-tools');

  const actions = [
    {
      key: 'text',
      label: 'Text',
      ariaLabel: 'Copy paragraph text to clipboard',
      getContent: () => getParagraphPlainText(paragraphElement),
    },
    {
      key: 'link',
      label: 'Link',
      ariaLabel: 'Copy direct link to this paragraph',
      getContent: () => getParagraphPermalink(paragraphId),
    },
    {
      key: 'citation',
      label: 'Citation',
      ariaLabel: 'Copy citation for this paragraph',
      getContent: () => getParagraphCitation(article, paragraphData),
    },
  ];

  paragraphElement.appendChild(createToolsWrapper(actions, 'Paragraph tools'));
};

// Copy/link/citation tools for a heading element (article heading or act root title).
const attachHeadingTools = (element, { getText, getLink, getCitation }) => {
  if (!element) {
    return;
  }

  element.classList.add('has-paragraph-tools');

  const actions = [
    { key: 'text', label: 'Text', ariaLabel: 'Copy heading text to clipboard', getContent: getText },
    { key: 'link', label: 'Link', ariaLabel: 'Copy direct link', getContent: getLink },
    { key: 'citation', label: 'Citation', ariaLabel: 'Copy citation', getContent: getCitation },
  ];

  element.appendChild(createToolsWrapper(actions, 'Heading tools'));
};
