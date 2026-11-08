// Central configuration contract for the extension.
// Keep this module free of side effects so every entry point (service worker,
// popup, options page, tests) can import the same source of truth.

export const STORAGE_KEYS = Object.freeze({
  provider: 'provider',
  useMock: 'useMock'
});

// Secrets and high-churn local state live in storage.local, never in
// storage.sync — sync payloads are replicated through the browser vendor's
// infrastructure and are not appropriate for credentials.
export const LOCAL_STORAGE_KEYS = Object.freeze({
  apiKey: 'apiKey',
  recentDomains: 'recentDomains',
  cachePrefix: 'analysisCache:'
});

export const MESSAGE_TYPES = Object.freeze({
  analyzeDomain: 'ANALYZE_DOMAIN'
});

export const DEFAULT_PROVIDER = Object.freeze({
  name: 'RapidAPI Similarweb',
  baseUrl: 'https://similarweb12.p.rapidapi.com',
  endpoints: Object.freeze({
    visits: '/v1/website/visits?domain=',
    geography: '/v1/website/top-countries?domain='
  }),
  headers: Object.freeze({
    'X-RapidAPI-Key': '__REPLACE__',
    'X-RapidAPI-Host': 'similarweb12.p.rapidapi.com'
  })
});

export const DEFAULT_USE_MOCK = true;
export const API_KEY_PLACEHOLDER = '__REPLACE__';
export const API_TIMEOUT_MS = 12_000;
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const HISTORY_LIMIT = 8;
