// Popup controller. Renders provider responses and delegates all network
// communication to the service worker. Every remote value is written via
// textContent or DOM construction — never through innerHTML.

import { MESSAGE_TYPES } from '../shared/constants.js';
import { getHostFromUrl, normalizeDomain } from '../shared/domain.js';
import {
  countryFlag,
  countryName,
  extractMonth,
  extractMonthlyHistory,
  extractVisits,
  formatNumber,
  formatPercent,
  shareToPercent,
  timeAgo
} from '../shared/format.js';
import { addRecentDomain, clearRecentDomains, getRecentDomains } from '../shared/recent-domains.js';

const qs = (id) => document.getElementById(id);

const elements = {
  form: qs('analyzeForm'),
  input: qs('domainInput'),
  analyzeButton: qs('analyzeBtn'),
  formError: qs('formError'),
  historyRow: qs('historyRow'),
  historyChips: qs('historyChips'),
  clearHistoryButton: qs('clearHistoryBtn'),
  optionsButton: qs('optionsBtn'),
  results: qs('results'),
  statusDomain: qs('statusDomain'),
  statusMeta: qs('statusMeta'),
  sourceBadge: qs('sourceBadge'),
  visits: qs('visits'),
  visitMonth: qs('visitMonth'),
  visitDelta: qs('visitDelta'),
  sparkline: qs('sparkline'),
  countries: qs('countries'),
  errorBox: qs('errorBox'),
  errorToggle: qs('errorToggle'),
  errorDetails: qs('errorDetails'),
  refreshButton: qs('refreshBtn'),
  copyButton: qs('copyBtn'),
  exportButton: qs('exportBtn'),
  similarwebButton: qs('similarwebLink')
};

let lastAnalysis = null;
let activeDomain = '';

function setAnalyzeBusy(busy) {
  elements.analyzeButton.disabled = busy;
  elements.input.disabled = busy;
  elements.analyzeButton.querySelector('.btn-label').textContent = busy ? 'Analyzing…' : 'Analyze';
}

function showFormError(message) {
  elements.formError.textContent = message;
  elements.formError.classList.remove('hidden');
}

function hideFormError() {
  elements.formError.textContent = '';
  elements.formError.classList.add('hidden');
}

async function getActiveTabDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url ? getHostFromUrl(tab.url) : '';
  } catch {
    // Without tab access (or for chrome:// pages) the field stays empty.
    return '';
  }
}

// ---------------------------------------------------------------------------
// Recent lookups
// ---------------------------------------------------------------------------

async function renderHistory() {
  const domains = await getRecentDomains().catch(() => []);
  elements.historyChips.replaceChildren();

  if (domains.length === 0) {
    elements.historyRow.classList.add('hidden');
    return;
  }

  for (const domain of domains) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = domain;
    chip.title = `Analyze ${domain} again`;
    chip.addEventListener('click', () => {
      elements.input.value = domain;
      void runAnalysis(domain);
    });
    elements.historyChips.appendChild(chip);
  }

  elements.historyRow.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function combineSources(visits, geography) {
  const sources = [visits?.source, geography?.source];
  if (sources.some((source) => source === 'fallback-mock')) return 'fallback-mock';
  if (sources.every((source) => source === 'mock')) return 'mock';
  if (sources.some((source) => source === 'mock')) return 'mixed';
  return 'api';
}

const BADGE_COPY = {
  api: { label: 'Live data', className: 'badge badge--live' },
  mock: { label: 'Demo data', className: 'badge badge--demo' },
  mixed: { label: 'Partial demo', className: 'badge badge--demo' },
  'fallback-mock': { label: 'Fallback', className: 'badge badge--fallback' }
};

function renderBadge(source) {
  const badge = BADGE_COPY[source] ?? BADGE_COPY['fallback-mock'];
  elements.sourceBadge.textContent = badge.label;
  elements.sourceBadge.className = badge.className;
}

function renderVisits(visits) {
  const data = visits?.data;
  const total = extractVisits(data);
  const month = extractMonth(data);

  elements.visits.textContent = total !== null ? formatNumber(total) : '—';
  elements.visitMonth.textContent = month ? `monthly visits · ${month}` : 'monthly visits';

  renderDelta(data);
  renderSparkline(data);
}

function renderDelta(data) {
  const history = extractMonthlyHistory(data);
  elements.visitDelta.classList.add('hidden');

  if (history.length < 2) return;

  const previous = history[history.length - 2].visits;
  const latest = history[history.length - 1].visits;
  if (previous <= 0) return;

  const delta = ((latest - previous) / previous) * 100;
  const direction = delta >= 0 ? '▲' : '▼';
  elements.visitDelta.textContent = `${direction} ${Math.abs(delta).toFixed(1)}% vs previous month`;
  elements.visitDelta.classList.remove('hidden', 'delta--up', 'delta--down');
  elements.visitDelta.classList.add(delta >= 0 ? 'delta--up' : 'delta--down');
}

function renderSparkline(data) {
  const history = extractMonthlyHistory(data);
  elements.sparkline.replaceChildren();
  elements.sparkline.classList.add('hidden');

  if (history.length < 3) return;

  const values = history.map((point) => point.visits);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  // Padding keeps the stroke fully inside the viewBox.
  const padX = 2;
  const padY = 3;
  const width = 120;
  const height = 36;

  const points = values.map((value, index) => {
    const x = padX + (index * (width - padX * 2)) / (values.length - 1);
    const y = height - padY - ((value - min) / span) * (height - padY * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', points.join(' '));
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', 'currentColor');
  polyline.setAttribute('stroke-width', '1.6');
  polyline.setAttribute('stroke-linecap', 'round');
  polyline.setAttribute('stroke-linejoin', 'round');

  const lastPoint = points[points.length - 1].split(',');
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', lastPoint[0]);
  dot.setAttribute('cy', lastPoint[1]);
  dot.setAttribute('r', '1.8');
  dot.setAttribute('fill', 'currentColor');

  elements.sparkline.append(polyline, dot);
  elements.sparkline.classList.remove('hidden');
}

function renderCountries(geography) {
  elements.countries.replaceChildren();

  const raw = geography?.data;
  const list = raw?.topCountries ?? raw?.countries ?? (Array.isArray(raw) ? raw : []);

  if (!Array.isArray(list) || list.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'countries-empty';
    empty.textContent = 'No country breakdown available.';
    elements.countries.appendChild(empty);
    return;
  }

  // Defensive copy: providers occasionally omit the ordering guarantee.
  const sorted = [...list]
    .map((entry) => ({
      code: String(entry?.country ?? entry?.code ?? '').toUpperCase(),
      share: Number(entry?.share ?? entry?.percent ?? entry?.value ?? 0) || 0
    }))
    .filter((entry) => entry.code)
    .sort((a, b) => b.share - a.share)
    .slice(0, 5);

  for (const entry of sorted) {
    const item = document.createElement('li');
    item.className = 'country-row';

    const flag = document.createElement('span');
    flag.className = 'country-flag';
    flag.textContent = countryFlag(entry.code);

    const name = document.createElement('span');
    name.className = 'code';
    name.textContent = entry.code;
    name.title = countryName(entry.code);

    const meter = document.createElement('span');
    meter.className = 'fill';
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.style.width = `${shareToPercent(entry.share)}%`;
    meter.appendChild(bar);

    const value = document.createElement('span');
    value.className = 'val';
    value.textContent = formatPercent(entry.share);

    item.append(flag, name, meter, value);
    elements.countries.appendChild(item);
  }
}

function renderErrorBox(visits, geography) {
  const failures = [visits, geography].filter((envelope) => envelope?.source === 'fallback-mock');
  elements.errorBox.classList.toggle('hidden', failures.length === 0);
  elements.errorDetails.textContent = failures
    .map((envelope, index) => `${index + 1}. ${envelope.error || 'Unknown provider error'}`)
    .join('\n');

  // Reset to the collapsed state on every new analysis.
  elements.errorDetails.classList.add('hidden');
  elements.errorToggle.setAttribute('aria-expanded', 'false');
  elements.errorToggle.textContent = 'Provider reported an issue — show details';
}

function buildSummaryText(analysis) {
  const total = extractVisits(analysis.visits?.data);
  const month = extractMonth(analysis.visits?.data);
  const raw = analysis.geography?.data;
  const list = raw?.topCountries ?? raw?.countries ?? [];
  const countries = (Array.isArray(list) ? list : [])
    .slice(0, 5)
    .map((entry) => `${String(entry?.country ?? entry?.code ?? '??').toUpperCase()} ${formatPercent(entry?.share ?? 0)}`)
    .join(', ');

  const lines = [
    `Traffic-Stats — ${analysis.domain}`,
    `Estimated visits: ${total !== null ? formatNumber(total) : 'n/a'}${month ? ` (${month})` : ''}`,
    `Source: ${combineSources(analysis.visits, analysis.geography)}`
  ];
  if (countries) lines.push(`Top countries: ${countries}`);
  return lines.join('\n');
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for contexts where the async clipboard API is unavailable.
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const succeeded = document.execCommand('copy');
    textarea.remove();
    return succeeded;
  }
}

function flashButtonLabel(button, label, duration = 1600) {
  const original = button.textContent;
  button.textContent = label;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, duration);
}

// ---------------------------------------------------------------------------
// Analysis flow
// ---------------------------------------------------------------------------

async function runAnalysis(rawDomain, { bypassCache = false } = {}) {
  const domain = normalizeDomain(rawDomain);
  hideFormError();

  if (!domain) {
    showFormError('Enter a valid domain, e.g. example.com');
    return;
  }

  activeDomain = domain;
  setAnalyzeBusy(true);
  elements.results.classList.remove('hidden');
  elements.statusDomain.textContent = domain;
  elements.statusMeta.textContent = 'Analyzing…';
  elements.sourceBadge.textContent = '';
  elements.sourceBadge.className = 'badge hidden';

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.analyzeDomain,
      domain,
      bypassCache
    });

    if (!response) {
      throw new Error('No response from the background worker.');
    }

    lastAnalysis = response;
    const source = combineSources(response.visits, response.geography);

    renderVisits(response.visits);
    renderCountries(response.geography);
    renderBadge(source);

    const tookSeconds = Number.isFinite(response.tookMs) ? (response.tookMs / 1000).toFixed(2) : null;
    elements.statusMeta.textContent = response.cached
      ? `cached · ${timeAgo(response.cachedAt)}`
      : tookSeconds
        ? `analyzed in ${tookSeconds}s`
        : '';

    renderErrorBox(response.visits, response.geography);
    await addRecentDomain(domain).catch(() => undefined);
    await renderHistory();
  } catch (error) {
    console.error('Traffic-Stats: analysis failed', error);
    showFormError('Analysis failed. Reload the extension and try again.');
    elements.statusMeta.textContent = '';
  } finally {
    setAnalyzeBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  void runAnalysis(elements.input.value);
});

elements.refreshButton.addEventListener('click', () => {
  if (activeDomain) void runAnalysis(activeDomain, { bypassCache: true });
});

elements.clearHistoryButton.addEventListener('click', async () => {
  await clearRecentDomains().catch(() => undefined);
  await renderHistory();
});

elements.optionsButton.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

elements.errorToggle.addEventListener('click', () => {
  const expanded = elements.errorToggle.getAttribute('aria-expanded') === 'true';
  elements.errorToggle.setAttribute('aria-expanded', String(!expanded));
  elements.errorDetails.classList.toggle('hidden', expanded);
  elements.errorToggle.textContent = expanded
    ? 'Provider reported an issue — show details'
    : 'Provider reported an issue — hide details';
});

elements.copyButton.addEventListener('click', async () => {
  if (!lastAnalysis) return;
  const copied = await copyToClipboard(buildSummaryText(lastAnalysis));
  flashButtonLabel(elements.copyButton, copied ? 'Copied ✓' : 'Copy failed');
});

elements.exportButton.addEventListener('click', () => {
  if (!lastAnalysis) return;

  const blob = new Blob([JSON.stringify(lastAnalysis, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `traffic-stats-${lastAnalysis.domain || 'export'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

elements.similarwebButton.addEventListener('click', () => {
  if (!activeDomain) return;
  const target = `https://www.similarweb.com/website/${encodeURIComponent(activeDomain)}/`;
  void chrome.tabs.create({ url: target });
});

document.addEventListener('DOMContentLoaded', async () => {
  const domain = await getActiveTabDomain();
  if (domain) elements.input.value = domain;

  await renderHistory();
  elements.input.focus();
});
