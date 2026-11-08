// Recent-domain history shown in the popup for one-click re-analysis.
// Stored as a small, de-duplicated MRU list in storage.local.

import { HISTORY_LIMIT, LOCAL_STORAGE_KEYS } from './constants.js';

// Pure list operation — exported for unit tests.
export function mergeRecentDomains(list, domain, limit = HISTORY_LIMIT) {
  const normalized = String(domain || '').trim().toLowerCase();
  if (!normalized) return Array.isArray(list) ? list.slice(0, limit) : [];

  const existing = Array.isArray(list) ? list : [];
  const deduped = existing.filter((entry) => entry !== normalized);
  return [normalized, ...deduped].slice(0, limit);
}

export async function getRecentDomains() {
  const stored = await chrome.storage.local.get(LOCAL_STORAGE_KEYS.recentDomains);
  const list = stored[LOCAL_STORAGE_KEYS.recentDomains];
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
}

export async function addRecentDomain(domain) {
  const list = await getRecentDomains();
  const next = mergeRecentDomains(list, domain);
  await chrome.storage.local.set({ [LOCAL_STORAGE_KEYS.recentDomains]: next });
  return next;
}

export async function clearRecentDomains() {
  await chrome.storage.local.remove(LOCAL_STORAGE_KEYS.recentDomains);
}
