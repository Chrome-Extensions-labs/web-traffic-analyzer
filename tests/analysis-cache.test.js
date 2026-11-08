import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CACHE_TTL_MS } from '../shared/constants.js';
import { cacheKeyFor, isCacheEntryFresh } from '../shared/analysis-cache.js';
import { mergeRecentDomains } from '../shared/recent-domains.js';

describe('cacheKeyFor', () => {
  it('prefixes domains with the cache namespace', () => {
    assert.equal(cacheKeyFor('example.com'), 'analysisCache:example.com');
  });
});

describe('isCacheEntryFresh', () => {
  const now = 1_800_000_000_000;

  it('accepts entries younger than the TTL', () => {
    const entry = { storedAt: now - CACHE_TTL_MS + 1000, payload: { domain: 'example.com' } };
    assert.equal(isCacheEntryFresh(entry, now), true);
  });

  it('rejects stale, future-dated and malformed entries', () => {
    assert.equal(isCacheEntryFresh({ storedAt: now - CACHE_TTL_MS, payload: {} }, now), false);
    assert.equal(isCacheEntryFresh({ storedAt: now + 60_000, payload: {} }, now), false);
    assert.equal(isCacheEntryFresh({ storedAt: 'oops', payload: {} }, now), false);
    assert.equal(isCacheEntryFresh({ storedAt: now, payload: null }, now), false);
    assert.equal(isCacheEntryFresh(null, now), false);
  });
});

describe('mergeRecentDomains', () => {
  it('moves the queried domain to the front and de-duplicates', () => {
    assert.deepEqual(
      mergeRecentDomains(['b.com', 'a.com', 'b.com'], 'b.com'),
      ['b.com', 'a.com']
    );
  });

  it('normalizes case and enforces the list limit', () => {
    const list = Array.from({ length: 8 }, (_, index) => `site${index}.com`);
    const merged = mergeRecentDomains(list, 'NEW.com', 8);
    assert.equal(merged.length, 8);
    assert.equal(merged[0], 'new.com');
  });

  it('tolerates non-array history and empty input', () => {
    assert.deepEqual(mergeRecentDomains(null, 'a.com'), ['a.com']);
    assert.deepEqual(mergeRecentDomains(['a.com'], ''), ['a.com']);
  });
});
