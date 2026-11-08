# API Reference

## 1. Overview

This Chrome extension integrates with a Similarweb-compatible RapidAPI provider to analyze a target domain and render two traffic insights in the popup UI:

- Estimated monthly visits for the domain.
- Top traffic countries with per-country share.

The default provider configuration uses the following RapidAPI base URL:

- `https://similarweb12.p.rapidapi.com`

## 2. Authentication (RapidAPI)

All requests are authenticated using RapidAPI headers. The extension injects these headers per request and replaces a placeholder key with the user-provided API key.

The API key is stored in `chrome.storage.local` under the `apiKey` key. It is never written to `chrome.storage.sync` and never appears in provider definitions persisted in synced storage. Keys saved by versions ≤ 2.x inside the synced provider object are migrated automatically on first load.

Required headers:

- `X-RapidAPI-Key`: Your RapidAPI subscription key.
- `X-RapidAPI-Host`: RapidAPI host for the provider (`similarweb12.p.rapidapi.com` by default).

```http
X-RapidAPI-Key: <YOUR_RAPIDAPI_KEY>
X-RapidAPI-Host: similarweb12.p.rapidapi.com
```

Custom provider origins are only reachable after an optional host-permission grant, requested from the options page when saving a non-default Base URL. Requests to non-granted origins short-circuit with a descriptive error instead of hanging.

## 3. Endpoints

### GET /v1/website/visits?domain={domain}

**Description**

Returns visit metrics for the requested domain. In the extension rendering logic, the visits value is read from one of these keys (in order): `visits`, `totalVisits`, `value`.

**Query Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | `string` | Yes | Domain to analyze. Must be normalized: no protocol (`http://`, `https://`), no leading `www.`, and no path segments. Example: `example.com`. |

**Responses**

`200 OK`

```json
{
  "domain": "example.com",
  "month": "2026-10",
  "visits": 1234567
}
```

---

### GET /v1/website/top-countries?domain={domain}

**Description**

Returns the top countries contributing traffic share for the requested domain. The extension expects an array in `topCountries` (or compatible alternatives), then displays up to 5 items.

**Query Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | `string` | Yes | Domain to analyze. Must be normalized: no protocol (`http://`, `https://`), no leading `www.`, and no path segments. Example: `example.com`. |

**Responses**

`200 OK`

```json
{
  "domain": "example.com",
  "topCountries": [
    { "country": "US", "share": 0.55 },
    { "country": "IN", "share": 0.44 },
    { "country": "GB", "share": 0.33 },
    { "country": "DE", "share": 0.22 },
    { "country": "CA", "share": 0.11 }
  ]
}
```

## 4. Error Handling & Fallback (Demo Mode)

The extension implements resilient fallback behavior for API unavailability and onboarding/demo workflows:

- If demo mode is enabled (`useMock = true`), requests bypass network calls and return local mock payloads.
- If `X-RapidAPI-Key` is missing/empty, the extension automatically forces mock mode.
- If an API request fails (HTTP non-2xx, network error, runtime exception), the extension returns local mock data with a fallback source marker.

Fallback response envelope (per endpoint call):

```json
{
  "ok": false,
  "data": { "...": "mock payload for this endpoint" },
  "source": "fallback-mock",
  "error": "HTTP 403"
}
```

During successful API execution, the call envelope is:

```json
{
  "ok": true,
  "data": { "...": "provider API JSON payload" },
  "source": "api"
}
```

## 5. Messaging Protocol

The popup and options pages never touch the network directly. They communicate with the service worker through `chrome.runtime.sendMessage`.

### `ANALYZE_DOMAIN` request

```json
{
  "type": "ANALYZE_DOMAIN",
  "domain": "example.com",
  "bypassCache": false
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` | Yes | Must be `ANALYZE_DOMAIN`. |
| `domain` | `string` | Yes | Raw input. Entries that cannot be normalized to a valid public domain yield an error envelope without network access. |
| `bypassCache` | `boolean` | No | When `true`, skips the six-hour analysis cache (Refresh button). |

### Response envelope

```json
{
  "domain": "example.com",
  "visits": { "ok": true, "data": {}, "source": "api" },
  "geography": { "ok": true, "data": {}, "source": "api" },
  "cached": false,
  "tookMs": 842
}
```

- `cached` is `true` when the payload was served from the local six-hour cache (`analysisCache:<domain>` in `chrome.storage.local`) without contacting the provider. Cached entries additionally carry `cachedAt` (Unix epoch milliseconds).
- Error envelopes (HTTP failures, timeouts, unreachable hosts) always resolve — never throw — and carry `source: "fallback-mock"` plus an `error` string. Fallback envelopes are never cached.
- `ok` reports whether the payload came from a successful response or from the bundled demo fixtures.

## 6. Local Storage Schema

| Key | Area | Description |
| --- | --- | --- |
| `provider` | sync | Endpoint/host definition (no secret material). |
| `useMock` | sync | Force Demo Mode. |
| `apiKey` | local | RapidAPI credential. Never synced. |
| `recentDomains` | local | MRU list of up to 8 analyzed domains. |
| `analysisCache:<domain>` | local | Cached analysis envelope with 6-hour TTL. |
