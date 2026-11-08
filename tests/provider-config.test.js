import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateProviderInput } from '../shared/provider-config.js';

const VALID = {
  baseUrl: 'https://similarweb12.p.rapidapi.com',
  hostHeader: 'similarweb12.p.rapidapi.com',
  epVisits: '/v1/website/visits?domain=',
  epGeo: '/v1/website/top-countries?domain='
};

describe('validateProviderInput', () => {
  it('accepts the bundled default provider', () => {
    const result = validateProviderInput(VALID);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('rejects non-https or credential-bearing base URLs', () => {
    assert.equal(validateProviderInput({ ...VALID, baseUrl: 'http://similarweb12.p.rapidapi.com' }).valid, false);
    assert.equal(validateProviderInput({ ...VALID, baseUrl: 'https://user:pass@example.com' }).valid, false);
    assert.equal(validateProviderInput({ ...VALID, baseUrl: 'not a url' }).valid, false);
  });

  it('rejects malformed host headers', () => {
    assert.equal(validateProviderInput({ ...VALID, hostHeader: 'not a host!' }).valid, false);
    assert.equal(validateProviderInput({ ...VALID, hostHeader: '' }).valid, false);
  });

  it('rejects endpoints without a leading slash', () => {
    assert.equal(validateProviderInput({ ...VALID, epVisits: 'v1/visits' }).valid, false);
    assert.equal(validateProviderInput({ ...VALID, epGeo: '  ' }).valid, false);
  });
});
