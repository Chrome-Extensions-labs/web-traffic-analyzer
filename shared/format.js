// Shared formatting and presentation helpers.
// Pure functions only — no DOM or extension APIs — so they can be unit-tested
// under plain Node.js.

export function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';

  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(numeric);
  } catch {
    return String(Math.round(numeric));
  }
}

// Accepts either a ratio (0.35) or an already-scaled percentage (35). Values
// above 1 are treated as percentages to stay tolerant of provider schemas.
export function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return '0.0%';

  const ratio = numeric > 1 ? numeric / 100 : numeric;
  return `${(ratio * 100).toFixed(1)}%`;
}

// Clamps a share value to a 0–100 percentage suitable for bar widths.
export function shareToPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;

  const ratio = numeric > 1 ? numeric / 100 : numeric;
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

// Extracts the visit count from a provider payload, honoring the multi-schema
// contract documented for RapidAPI/Similarweb-compatible providers.
export function extractVisits(data) {
  if (!data || typeof data !== 'object') return null;

  const candidate = data.visits ?? data.totalVisits ?? data.value ?? data.visitsCount;
  const numeric = Number(candidate);
  return Number.isFinite(numeric) ? numeric : null;
}

// Extracts the display month (e.g. "2025-07") when the provider supplies one.
export function extractMonth(data) {
  if (!data || typeof data !== 'object') return '';
  const month = data.month ?? data.date ?? data.period;
  return typeof month === 'string' ? month : '';
}

// Extracts an optional monthly history series for the sparkline. Each entry
// must carry a visit count; labels fall back to positional indices.
export function extractMonthlyHistory(data) {
  if (!data || typeof data !== 'object') return [];

  const series = data.history ?? data.monthlyVisits ?? data.trend;
  if (!Array.isArray(series)) return [];

  return series
    .map((entry) => {
      if (entry == null || typeof entry !== 'object') return null;
      const visits = Number(entry.visits ?? entry.value ?? entry.totalVisits);
      if (!Number.isFinite(visits)) return null;
      const label = typeof entry.month === 'string' ? entry.month : typeof entry.date === 'string' ? entry.date : '';
      return { label, visits };
    })
    .filter(Boolean);
}

// Maps a share ratio to a flag emoji using regional indicator symbols.
// Returns a neutral globe when the code is not a supported region.
export function countryFlag(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return '🌐';

  const base = 0x1f1e6; // regional indicator symbol letter A
  const first = normalized.charCodeAt(0) - 65 + base;
  const second = normalized.charCodeAt(1) - 65 + base;
  return String.fromCodePoint(first, second);
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

export function countryName(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return normalized || 'Unknown';

  try {
    return regionNames?.of(normalized) ?? normalized;
  } catch {
    return normalized;
  }
}

// Human-readable relative time ("just now", "5m ago", "3h ago") for cache
// timestamps and history entries.
export function timeAgo(timestamp) {
  const time = Number(timestamp);
  if (!Number.isFinite(time)) return '';

  const elapsed = Date.now() - time;
  if (elapsed < 45_000) return 'just now';

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
