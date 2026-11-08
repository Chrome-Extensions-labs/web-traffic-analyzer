// Integration-style coverage for the service worker message router.
// The worker's listeners are captured through a mocked `chrome` global, and
// fetch is stubbed — no browser or network access required.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { MESSAGE_TYPES } from '../shared/constants.js';

const store = { sync: new Map(), local: new Map() };

const makeStorageArea = (map) => ({
  async get(keys) {
    if (keys === null || keys === undefined) return Object.fromEntries(map);
    const list = Array.isArray(keys) ? keys : [keys];
    const result = {};
    for (const key of list) {
      if (map.has(key)) result[key] = map.get(key);
    }
    return result;
  },
  async set(items) {
    for (const [key, value] of Object.entries(items)) map.set(key, value);
  },
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key);
  }
});

const listeners = {};

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
    onMessage: { addListener: (fn) => { listeners.message = fn; } }
  },
  storage: {
    sync: makeStorageArea(store.sync),
    local: makeStorageArea(store.local)
  },
  permissions: {
    contains: async () => true,
    request: async () => true
  }
};

const sendMessage = (message) =>
  new Promise((resolve, reject) => {
    const keepAlive = listeners.message(
      message,
      {},
      (response) => resolve(response)
    );
    assert.equal(keepAlive, true, 'worker must keep the response channel open');
  });

before(async () => {
  await import('../background/service-worker.js');
});

describe('ANALYZE_DOMAIN handler', () => {
  it('normalizes raw input and serves demo data without an API key', async () => {
    store.sync.clear();
    store.local.clear();

    const response = await sendMessage({ type: MESSAGE_TYPES.analyzeDomain, domain: 'HTTPS://www.Example.com/path?q=1' });

    assert.equal(response.domain, 'example.com');
    assert.equal(response.cached, false);
    assert.equal(response.visits.source, 'mock');
    assert.equal(response.geography.source, 'mock');
    assert.equal(typeof response.tookMs, 'number');
  });

  it('serves repeat lookups from cache until bypassed', async () => {
    store.sync.clear();
    store.local.clear();

    const first = await sendMessage({ type: MESSAGE_TYPES.analyzeDomain, domain: 'cached.example.com' });
    assert.equal(first.cached, false);

    const second = await sendMessage({ type: MESSAGE_TYPES.analyzeDomain, domain: 'cached.example.com' });
    assert.equal(second.cached, true);
    assert.equal(typeof second.cachedAt, 'number');

    const third = await sendMessage({ type: MESSAGE_TYPES.analyzeDomain, domain: 'cached.example.com', bypassCache: true });
    assert.equal(third.cached, false);
  });

  it('rejects invalid input without touching the network', async () => {
    const response = await sendMessage({ type: MESSAGE_TYPES.analyzeDomain, domain: 'not a domain!' });

    assert.equal(response.domain, '');
    assert.equal(response.visits.ok, false);
    assert.match(response.visits.error, /valid domain/i);
    assert.equal(response.geography.ok, false);
  });

  it('never caches provider failures', async () => {
    store.sync.clear();
    store.local.clear();
    await chrome.storage.sync.set({ useMock: false });
    await chrome.storage.local.set({ apiKey: 'test-key' });

    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: 'plan exceeded' }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      });
    };

    try {
      const first = await sendMessage({ type: MESSAGE_TYPES.analyzeDomain, domain: 'quota.example.com' });
      assert.equal(first.visits.source, 'fallback-mock');
      assert.match(first.visits.error, /429/);

      await sendMessage({ type: MESSAGE_TYPES.analyzeDomain, domain: 'quota.example.com' });
      assert.ok(calls >= 4, 'fallback responses must not be served from cache');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
