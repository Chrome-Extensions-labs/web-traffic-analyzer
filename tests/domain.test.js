import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getHostFromUrl, isValidDomain, normalizeDomain } from '../shared/domain.js';

describe('normalizeDomain', () => {
  it('strips scheme, path, query and leading www', () => {
    assert.equal(normalizeDomain('https://www.example.com/blog/post?a=1#frag'), 'example.com');
    assert.equal(normalizeDomain('http://example.com'), 'example.com');
    assert.equal(normalizeDomain('example.com/some/path'), 'example.com');
  });

  it('normalizes case, ports, credentials and trailing dots', () => {
    assert.equal(normalizeDomain('HTTPS://USER:pass@Example.COM.:8080/'), 'example.com');
    assert.equal(normalizeDomain('  WWW.Example.co.uk  '), 'example.co.uk');
  });

  it('keeps meaningful subdomains and punycode-encodes IDN hosts', () => {
    assert.equal(normalizeDomain('api.news.example.co.uk'), 'api.news.example.co.uk');
    assert.equal(normalizeDomain('https://пример.рф'), 'xn--e1afmkfd.xn--p1ai');
  });

  it('handles protocol-relative URLs', () => {
    assert.equal(normalizeDomain('//cdn.example.com/lib.js'), 'cdn.example.com');
  });

  it('rejects input that is not a public domain', () => {
    assert.equal(normalizeDomain('localhost'), '');
    assert.equal(normalizeDomain('not a domain'), '');
    assert.equal(normalizeDomain(''), '');
    assert.equal(normalizeDomain('javascript:alert(1)'), '');
    assert.equal(normalizeDomain('a_b.example.com'), '');
    assert.equal(normalizeDomain(null), '');
  });
});

describe('isValidDomain', () => {
  it('accepts conventional public domains', () => {
    assert.ok(isValidDomain('example.com'));
    assert.ok(isValidDomain('a-b.example-c.org'));
  });

  it('rejects malformed or bare hosts', () => {
    assert.equal(isValidDomain(''), false);
    assert.equal(isValidDomain('localhost'), false);
    assert.equal(isValidDomain('-bad.example.com'), false);
    assert.equal(isValidDomain('bad-.example.com'), false);
    assert.equal(isValidDomain('example.c'), false);
    assert.equal(isValidDomain(`${'a'.repeat(64)}.example.com`), false);
  });
});

describe('getHostFromUrl', () => {
  it('extracts and normalizes the host of absolute URLs', () => {
    assert.equal(getHostFromUrl('https://www.Example.com/path'), 'example.com');
  });

  it('returns an empty string for non-http schemes and garbage', () => {
    assert.equal(getHostFromUrl('chrome://extensions'), '');
    assert.equal(getHostFromUrl('not a url'), '');
  });
});
