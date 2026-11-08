// Domain canonicalization helpers.
//
// Everything that crosses the extension boundary (message payloads, API query
// strings, outbound requests) must pass through normalizeDomain() first so the
// rest of the codebase can rely on a single, well-defined representation:
// lowercase, bare host, no scheme, no credentials, no port, no path, no
// trailing dot, and (optionally) punycode-encoded via the URL parser.

const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_PATTERN = new RegExp(`^${DOMAIN_LABEL}(\\.${DOMAIN_LABEL})+$`);

// Strips IDN host to punycode through the platform URL parser and returns the
// bare host, or an empty string when the input cannot be interpreted at all.
function parseHost(candidate) {
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    return new URL(withScheme).hostname;
  } catch {
    return '';
  }
}

export function isValidDomain(domain) {
  if (typeof domain !== 'string' || domain.length > 253) return false;
  if (!DOMAIN_PATTERN.test(domain)) return false;

  const labels = domain.split('.');
  const tld = labels[labels.length - 1];
  // The public suffix is expected to be alphabetic (or punycode "xn--"), and
  // at least one dot must separate host and suffix — this rejects bare hosts
  // such as "localhost" in the UI while remaining provider-agnostic.
  return /^[a-z]{2,}$/.test(tld) || /^xn--[a-z0-9-]{2,}$/.test(tld);
}

export function normalizeDomain(input = '') {
  if (typeof input !== 'string') return '';

  let candidate = input.trim().toLowerCase();
  if (!candidate) return '';

  // Handle protocol-relative URLs and accidental user-typed prefixes.
  candidate = candidate.replace(/^\/\//, 'https://');
  if (candidate.startsWith('www.')) {
    candidate = candidate.slice(4);
  }

  const host = parseHost(candidate)
    .replace(/\.$/, '')     // trailing dot (FQDN notation)
    .replace(/^\.+|\.+$/g, '');

  const bareHost = host.replace(/^www\./, '');
  return isValidDomain(bareHost) ? bareHost : '';
}

export function getHostFromUrl(url = '') {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return '';
  }
}
