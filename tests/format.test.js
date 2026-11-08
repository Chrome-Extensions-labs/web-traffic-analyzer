import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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

describe('formatNumber', () => {
  it('formats finite numbers and preserves the digits', () => {
    assert.equal(formatNumber(1234567).replace(/\D/g, ''), '1234567');
    assert.equal(formatNumber('0').replace(/\D/g, ''), '0');
  });

  it('falls back to an em dash for non-numeric input', () => {
    assert.equal(formatNumber('nope'), '—');
    assert.equal(formatNumber(Number.POSITIVE_INFINITY), '—');
  });
});

describe('formatPercent / shareToPercent', () => {
  it('accepts ratios and already-scaled percentages', () => {
    assert.equal(formatPercent(0.55), '55.0%');
    assert.equal(formatPercent(55), '55.0%');
    assert.equal(shareToPercent(0.34), 34);
    assert.equal(shareToPercent(34), 34);
  });

  it('clamps invalid input', () => {
    assert.equal(formatPercent(-1), '0.0%');
    assert.equal(formatPercent('abc'), '0.0%');
    assert.equal(shareToPercent(-5), 0);
    assert.equal(shareToPercent(999), 100);
  });
});

describe('extractVisits / extractMonth', () => {
  it('reads visits from the documented multi-schema contract', () => {
    assert.equal(extractVisits({ visits: 100 }), 100);
    assert.equal(extractVisits({ totalVisits: 200 }), 200);
    assert.equal(extractVisits({ value: 300 }), 300);
    assert.equal(extractVisits({ visitsCount: 400 }), 400);
    assert.equal(extractVisits({}), null);
    assert.equal(extractVisits(null), null);
    assert.equal(extractVisits({ visits: '1,500' }), null);
  });

  it('extracts the reporting month when present', () => {
    assert.equal(extractMonth({ month: '2025-07' }), '2025-07');
    assert.equal(extractMonth({}), '');
  });
});

describe('extractMonthlyHistory', () => {
  it('parses well-formed series and drops malformed points', () => {
    const history = extractMonthlyHistory({
      history: [
        { month: '2025-05', visits: 10 },
        { month: '2025-06' },
        { visits: 'oops' },
        { month: '2025-07', visits: '30' }
      ]
    });

    assert.deepEqual(history, [
      { label: '2025-05', visits: 10 },
      { label: '2025-07', visits: 30 }
    ]);
  });

  it('returns an empty array for missing or invalid series', () => {
    assert.deepEqual(extractMonthlyHistory({}), []);
    assert.deepEqual(extractMonthlyHistory({ history: 'nope' }), []);
  });
});

describe('countryFlag / countryName', () => {
  it('renders regional indicator flags for ISO codes', () => {
    assert.equal(countryFlag('us'), '🇺🇸');
    assert.equal(countryFlag('DE'), '🇩🇪');
    assert.equal(countryFlag('x1'), '🌐');
    assert.equal(countryFlag(''), '🌐');
  });

  it('resolves display names with a safe fallback', () => {
    assert.equal(countryName('US'), 'United States');
    // ICU builds differ on unknown codes; the contract only requires a
    // non-empty string rather than an exception.
    assert.ok(typeof countryName('ZZ') === 'string' && countryName('ZZ').length > 0);
    assert.equal(countryName('!'), '!');
  });
});

describe('timeAgo', () => {
  it('describes recent timestamps', () => {
    assert.equal(timeAgo(Date.now()), 'just now');
    assert.equal(timeAgo(Date.now() - 5 * 60_000), '5m ago');
    assert.equal(timeAgo(Date.now() - 3 * 3_600_000), '3h ago');
    assert.equal(timeAgo(Number.NaN), '');
  });
});
