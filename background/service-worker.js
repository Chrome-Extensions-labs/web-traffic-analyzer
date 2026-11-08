// Service worker: owns all provider communication.
//
// The popup and options pages never talk to the network directly. They send
// messages here; this module resolves configuration, enforces the cache, calls
// the provider with a bounded timeout, and always answers with a structured
// envelope so the UI can render a deterministic shape.

import {
  API_TIMEOUT_MS,
  DEFAULT_PROVIDER,
  DEFAULT_USE_MOCK,
  MESSAGE_TYPES,
  STORAGE_KEYS
} from '../shared/constants.js';
import { normalizeDomain } from '../shared/domain.js';
import { MOCK } from '../shared/mock-data.js';
import { buildRequestHeaders, loadProviderConfig } from '../shared/provider-config.js';
import { readAnalysisCache, writeAnalysisCache } from '../shared/analysis-cache.js';

const PROVIDER_LOG_PREFIX = 'Traffic-Stats';

// Persists first-run defaults without overwriting existing installs.
async function ensureDefaults() {
  const stored = await chrome.storage.sync.get([STORAGE_KEYS.provider, STORAGE_KEYS.useMock]);

  const updates = {};
  if (!stored[STORAGE_KEYS.provider]) {
    updates[STORAGE_KEYS.provider] = {
      name: DEFAULT_PROVIDER.name,
      baseUrl: DEFAULT_PROVIDER.baseUrl,
      endpoints: { ...DEFAULT_PROVIDER.endpoints },
      headers: { ...DEFAULT_PROVIDER.headers }
    };
  }
  if (stored[STORAGE_KEYS.useMock] === undefined) {
    updates[STORAGE_KEYS.useMock] = DEFAULT_USE_MOCK;
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
  }
}

function mockEnvelope(payload) {
  return { ok: true, data: payload, source: 'mock' };
}

function fallbackEnvelope(payload, error) {
  return { ok: false, data: payload, source: 'fallback-mock', error };
}

// Reads an error body when present and extracts a short, safe message.
async function extractProviderError(response) {
  try {
    const body = await response.json();
    const message = body?.message ?? body?.error ?? body?.detail;
    if (typeof message === 'string' && message.trim()) {
      return `HTTP ${response.status}: ${message.trim().slice(0, 200)}`;
    }
  } catch {
    // Body was not JSON or already consumed — fall through to the status line.
  }
  return `HTTP ${response.status}`;
}

async function fetchJson({ url, headers, useMock, mockPayload }) {
  if (useMock) {
    // Keep a small delay so Demo Mode exercises the same async rendering path
    // as the live provider instead of short-circuiting synchronously.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return mockEnvelope(mockPayload);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      return fallbackEnvelope(mockPayload, await extractProviderError(response));
    }

    return { ok: true, data: await response.json(), source: 'api' };
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    const message = isTimeout
      ? `Request timed out after ${Math.round(API_TIMEOUT_MS / 1000)}s`
      : error?.message || 'Network error';
    console.warn(`${PROVIDER_LOG_PREFIX}: provider request failed — ${message}`);
    return fallbackEnvelope(mockPayload, message);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Confirms the extension holds a host permission covering the provider origin.
// Custom providers outside the manifest's static permissions require an
// optional permission grant (requested from the options page on save).
async function hasPermissionFor(urlString) {
  try {
    const origin = new URL(urlString).origin + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    // If the permissions API is unavailable, fall through and let the fetch
    // itself fail — the error path already produces a safe fallback envelope.
    return true;
  }
}

function buildProviderUrl(baseUrl, endpoint, domain) {
  return `${baseUrl}${endpoint}${encodeURIComponent(domain)}`;
}

async function analyzeDomain(rawDomain, { bypassCache = false } = {}) {
  const startedAt = Date.now();
  const domain = normalizeDomain(rawDomain);

  if (!domain) {
    const reason = 'Enter a valid domain, e.g. example.com';
    return {
      domain: '',
      visits: fallbackEnvelope(MOCK.visits, reason),
      geography: fallbackEnvelope(MOCK.geography, reason),
      cached: false,
      tookMs: Date.now() - startedAt
    };
  }

  if (!bypassCache) {
    const cached = await readAnalysisCache(domain).catch(() => null);
    if (cached) {
      return {
        ...cached.payload,
        cached: true,
        cachedAt: cached.storedAt,
        tookMs: Date.now() - startedAt
      };
    }
  }

  const { provider, apiKey, useMock } = await loadProviderConfig();
  const headers = buildRequestHeaders(provider, apiKey);
  // Without credentials the provider would reject every call, so Demo Mode is
  // the deterministic behavior rather than a confusing 401/403 stream.
  const shouldUseMock = Boolean(useMock) || headers === null;

  const visitsUrl = buildProviderUrl(provider.baseUrl, provider.endpoints.visits, domain);
  const geographyUrl = buildProviderUrl(provider.baseUrl, provider.endpoints.geography, domain);

  if (!shouldUseMock) {
    const permitted = await hasPermissionFor(provider.baseUrl);
    if (!permitted) {
      const reason = `Host permission not granted for ${new URL(provider.baseUrl).origin}. Save the provider settings again and grant access.`;
      return {
        domain,
        visits: fallbackEnvelope(MOCK.visits, reason),
        geography: fallbackEnvelope(MOCK.geography, reason),
        cached: false,
        tookMs: Date.now() - startedAt
      };
    }
  }

  const [visits, geography] = await Promise.all([
    fetchJson({ url: visitsUrl, headers, useMock: shouldUseMock, mockPayload: MOCK.visits }),
    fetchJson({ url: geographyUrl, headers, useMock: shouldUseMock, mockPayload: MOCK.geography })
  ]);

  const result = {
    domain,
    visits,
    geography,
    cached: false,
    tookMs: Date.now() - startedAt
  };

  // Error fallbacks are intentionally never cached — they must not pin the UI
  // to stale demo data after the provider recovers.
  const succeeded = [visits, geography].every((envelope) => envelope.source !== 'fallback-mock');
  if (succeeded) {
    const { tookMs: _tookMs, cached: _cached, ...cacheable } = result;
    await writeAnalysisCache(domain, cacheable).catch((error) => {
      console.warn(`${PROVIDER_LOG_PREFIX}: unable to persist analysis cache — ${error?.message}`);
    });
  }

  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  // Trigger the legacy API-key migration eagerly so synced copies are scrubbed
  // at install/update time instead of on first use.
  Promise.all([ensureDefaults(), loadProviderConfig()]).catch((error) => {
    console.warn(`${PROVIDER_LOG_PREFIX}: post-install setup failed — ${error?.message}`);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MESSAGE_TYPES.analyzeDomain) return false;

  analyzeDomain(message.domain, { bypassCache: Boolean(message.bypassCache) })
    .then(sendResponse)
    .catch((error) => {
      console.error(`${PROVIDER_LOG_PREFIX}: analysis failed unexpectedly`, error);
      sendResponse({
        domain: normalizeDomain(message.domain),
        visits: fallbackEnvelope(MOCK.visits, 'Internal analysis error'),
        geography: fallbackEnvelope(MOCK.geography, 'Internal analysis error'),
        cached: false
      });
    });

  // Return true to keep the message channel open for the async response.
  return true;
});
