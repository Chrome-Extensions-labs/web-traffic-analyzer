// TTL cache for analysis payloads, backed by storage.local.
//
// Provider quota is the scarcest resource in this extension, so identical
// lookups within CACHE_TTL_MS are served from cache. The envelope returned to
// the UI is tagged with cache metadata instead of reaching the network.

import { CACHE_TTL_MS, LOCAL_STORAGE_KEYS } from './constants.js';

export const cacheKeyFor = (domain) => `${LOCAL_STORAGE_KEYS.cachePrefix}${domain}`;

// Pure predicate — exported for unit tests.
export function isCacheEntryFresh(entry, now = Date.now(), ttlMs = CACHE_TTL_MS) {
  if (!entry || typeof entry !== 'object') return false;
  const storedAt = Number(entry.storedAt);
  if (!Number.isFinite(storedAt)) return false;
  if (!entry.payload || typeof entry.payload !== 'object') return false;
  return now - storedAt >= 0 && now - storedAt < ttlMs;
}

export async function readAnalysisCache(domain) {
  const key = cacheKeyFor(domain);
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];

  if (!isCacheEntryFresh(entry)) return null;
  return { payload: entry.payload, storedAt: entry.storedAt };
}

export async function writeAnalysisCache(domain, payload, now = Date.now()) {
  const key = cacheKeyFor(domain);
  await chrome.storage.local.set({ [key]: { storedAt: now, payload } });
}

export async function clearAnalysisCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(LOCAL_STORAGE_KEYS.cachePrefix));
  if (keys.length > 0) {
    await chrome.storage.local.remove(keys);
  }
  return keys.length;
}
