// Provider configuration access layer.
//
// The provider definition (base URL, endpoints, headers) is user-editable and
// lives in storage.sync so it follows the browser profile. The RapidAPI key is
// a credential: it is stored separately in storage.local and is never synced.
// A one-time migration promotes any legacy key found inside the synced
// provider object into local storage.

import {
  API_KEY_PLACEHOLDER,
  DEFAULT_PROVIDER,
  DEFAULT_USE_MOCK,
  LOCAL_STORAGE_KEYS,
  STORAGE_KEYS
} from './constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Deep-merges the stored provider over the defaults so new fields introduced
// in later versions appear even for installs persisted with an older schema.
function mergeProvider(stored) {
  const base = {
    name: DEFAULT_PROVIDER.name,
    baseUrl: DEFAULT_PROVIDER.baseUrl,
    endpoints: { ...DEFAULT_PROVIDER.endpoints },
    headers: { ...DEFAULT_PROVIDER.headers }
  };

  if (!isObject(stored)) return base;

  return {
    name: typeof stored.name === 'string' && stored.name.trim() ? stored.name : base.name,
    baseUrl: typeof stored.baseUrl === 'string' && stored.baseUrl.trim() ? stored.baseUrl.trim() : base.baseUrl,
    endpoints: {
      visits: typeof stored.endpoints?.visits === 'string' && stored.endpoints.visits.trim()
        ? stored.endpoints.visits.trim()
        : base.endpoints.visits,
      geography: typeof stored.endpoints?.geography === 'string' && stored.endpoints.geography.trim()
        ? stored.endpoints.geography.trim()
        : base.endpoints.geography
    },
    headers: {
      ...base.headers,
      ...(isObject(stored.headers) ? stored.headers : {})
    }
  };
}

async function readApiKey() {
  const stored = await chrome.storage.local.get(LOCAL_STORAGE_KEYS.apiKey);
  return typeof stored[LOCAL_STORAGE_KEYS.apiKey] === 'string'
    ? stored[LOCAL_STORAGE_KEYS.apiKey].trim()
    : '';
}

// Moves a legacy key (previously persisted inside the synced provider object)
// into storage.local. Runs best-effort: failures leave the legacy value intact
// rather than destroying user credentials.
async function migrateLegacyApiKey(storedProvider) {
  if (!isObject(storedProvider) || typeof storedProvider.apiKey !== 'string') return '';
  const legacy = storedProvider.apiKey.trim();
  if (!legacy) return '';

  try {
    await chrome.storage.local.set({ [LOCAL_STORAGE_KEYS.apiKey]: legacy });
    const { apiKey: _dropped, ...rest } = storedProvider;
    await chrome.storage.sync.set({ [STORAGE_KEYS.provider]: rest });
    return legacy;
  } catch (error) {
    console.warn('Traffic-Stats: API key migration failed, keeping legacy value.', error?.message);
    return legacy;
  }
}

export async function loadProviderConfig() {
  const [syncStored, localStored] = await Promise.all([
    chrome.storage.sync.get([STORAGE_KEYS.provider, STORAGE_KEYS.useMock]),
    chrome.storage.local.get(LOCAL_STORAGE_KEYS.apiKey)
  ]);

  const legacyKey = await migrateLegacyApiKey(syncStored[STORAGE_KEYS.provider]);
  const apiKey = (typeof localStored[LOCAL_STORAGE_KEYS.apiKey] === 'string'
    ? localStored[LOCAL_STORAGE_KEYS.apiKey].trim()
    : '') || legacyKey;

  return {
    provider: mergeProvider(syncStored[STORAGE_KEYS.provider]),
    apiKey,
    useMock: syncStored[STORAGE_KEYS.useMock] ?? DEFAULT_USE_MOCK
  };
}

// Validates user-supplied provider settings before they are persisted.
// Returns { valid, errors } where errors are user-facing English messages.
export function validateProviderInput({ baseUrl, hostHeader, epVisits, epGeo }) {
  const errors = [];

  let parsed;
  try {
    parsed = new URL(String(baseUrl || '').trim());
  } catch {
    parsed = null;
  }

  if (!parsed || parsed.protocol !== 'https:') {
    errors.push('Base URL must be a valid https:// URL.');
  } else if (parsed.username || parsed.password) {
    errors.push('Base URL must not contain embedded credentials.');
  }

  const host = String(hostHeader || '').trim();
  if (!/^(\*\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(host)) {
    errors.push('RapidAPI Host must be a valid host name (e.g. similarweb12.p.rapidapi.com).');
  }

  for (const [label, endpoint] of [['Visits', epVisits], ['Top Countries', epGeo]]) {
    const value = String(endpoint || '').trim();
    if (!value.startsWith('/')) {
      errors.push(`${label} endpoint must start with "/" (e.g. /v1/website/…).`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// Persists the provider definition and the API key to their respective
// storage areas. Returns void; callers surface errors to the user.
export async function saveProviderConfig({ provider, apiKey, useMock }) {
  const key = String(apiKey || '').trim();

  const sanitizedProvider = {
    name: typeof provider.name === 'string' && provider.name.trim() ? provider.name.trim() : DEFAULT_PROVIDER.name,
    baseUrl: provider.baseUrl.replace(/\/+$/, ''),
    endpoints: {
      visits: provider.endpoints.visits,
      geography: provider.endpoints.geography
    },
    headers: {
      'X-RapidAPI-Key': API_KEY_PLACEHOLDER,
      'X-RapidAPI-Host': provider.headers['X-RapidAPI-Host']
    }
  };

  await Promise.all([
    chrome.storage.sync.set({
      [STORAGE_KEYS.provider]: sanitizedProvider,
      [STORAGE_KEYS.useMock]: Boolean(useMock)
    }),
    key
      ? chrome.storage.local.set({ [LOCAL_STORAGE_KEYS.apiKey]: key })
      : chrome.storage.local.remove(LOCAL_STORAGE_KEYS.apiKey)
  ]);
}

export async function resetProviderConfig() {
  await Promise.all([
    chrome.storage.sync.set({
      [STORAGE_KEYS.provider]: {
        name: DEFAULT_PROVIDER.name,
        baseUrl: DEFAULT_PROVIDER.baseUrl,
        endpoints: { ...DEFAULT_PROVIDER.endpoints },
        headers: { ...DEFAULT_PROVIDER.headers }
      },
      [STORAGE_KEYS.useMock]: DEFAULT_USE_MOCK
    }),
    chrome.storage.local.remove(LOCAL_STORAGE_KEYS.apiKey)
  ]);
}

// Expands the __REPLACE__ placeholder with the effective key. Returns null
// when no key is configured so callers can route to Demo Mode deterministically.
export function buildRequestHeaders(provider, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return null;

  return Object.fromEntries(
    Object.entries(provider.headers || {}).map(([name, value]) => [
      name,
      String(value).split(API_KEY_PLACEHOLDER).join(key)
    ])
  );
}
