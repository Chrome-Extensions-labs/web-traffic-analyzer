// Demo fixtures used when Demo Mode is enabled or when the provider is
// unreachable. Values are deterministic so the UI can be exercised and tested
// without network access or API quota.
//
// Shares are ratios in [0, 1] and intentionally sum to less than 1 — the
// remainder represents long-tail countries that are not listed.

export const MOCK = Object.freeze({
  visits: Object.freeze({
    domain: 'example.com',
    month: '2026-10',
    visits: 1234567,
    history: Object.freeze([
      Object.freeze({ month: '2026-05', visits: 984210 }),
      Object.freeze({ month: '2026-06', visits: 1045670 }),
      Object.freeze({ month: '2026-07', visits: 1128904 }),
      Object.freeze({ month: '2026-08', visits: 1098340 }),
      Object.freeze({ month: '2026-09', visits: 1156800 }),
      Object.freeze({ month: '2026-10', visits: 1234567 })
    ])
  }),
  geography: Object.freeze({
    domain: 'example.com',
    topCountries: Object.freeze([
      Object.freeze({ country: 'US', share: 0.34 }),
      Object.freeze({ country: 'IN', share: 0.17 }),
      Object.freeze({ country: 'GB', share: 0.08 }),
      Object.freeze({ country: 'DE', share: 0.06 }),
      Object.freeze({ country: 'CA', share: 0.05 })
    ])
  })
});
