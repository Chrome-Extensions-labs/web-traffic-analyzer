// Options page controller. Validates provider settings before persisting
// them, manages the locally stored API key, and offers maintenance actions
// (connection test, factory reset, cache purge).

import { MESSAGE_TYPES } from '../shared/constants.js';
import {
  loadProviderConfig,
  resetProviderConfig,
  saveProviderConfig,
  validateProviderInput
} from '../shared/provider-config.js';
import { clearAnalysisCache } from '../shared/analysis-cache.js';

const qs = (id) => document.getElementById(id);

const elements = {
  form: qs('settingsForm'),
  baseUrl: qs('baseUrl'),
  hostHeader: qs('hostHeader'),
  epVisits: qs('epVisits'),
  epGeo: qs('epGeo'),
  apiKey: qs('apiKey'),
  toggleKeyVisibility: qs('toggleKeyVisibility'),
  useMock: qs('useMock'),
  validationErrors: qs('validationErrors'),
  saveStatus: qs('saveStatus'),
  testButton: qs('testBtn'),
  resetButton: qs('resetBtn'),
  clearCacheButton: qs('clearCacheBtn')
};

// Hosts covered by the manifest's static host_permissions. Anything else
// requires a runtime optional permission grant from this page.
const STATIC_PROVIDER_SUFFIXES = ['rapidapi.com', 'similarweb.com'];

function isCoveredByStaticPermissions(origin) {
  try {
    const { hostname } = new URL(origin);
    return STATIC_PROVIDER_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
    );
  } catch {
    return false;
  }
}

function setStatus(message, kind = 'ok') {
  elements.saveStatus.textContent = message;
  elements.saveStatus.className = `save-status save-status--${kind}`;
  if (message) {
    setTimeout(() => {
      if (elements.saveStatus.textContent === message) {
        elements.saveStatus.textContent = '';
      }
    }, 4000);
  }
}

function renderValidationErrors(errors) {
  elements.validationErrors.replaceChildren();

  if (errors.length === 0) {
    elements.validationErrors.classList.add('hidden');
    return;
  }

  for (const error of errors) {
    const item = document.createElement('li');
    item.textContent = error;
    elements.validationErrors.appendChild(item);
  }
  elements.validationErrors.classList.remove('hidden');
}

function readForm() {
  return {
    baseUrl: elements.baseUrl.value.trim(),
    hostHeader: elements.hostHeader.value.trim(),
    epVisits: elements.epVisits.value.trim(),
    epGeo: elements.epGeo.value.trim(),
    apiKey: elements.apiKey.value.trim(),
    useMock: elements.useMock.checked
  };
}

async function loadForm() {
  const { provider, apiKey, useMock } = await loadProviderConfig();

  elements.baseUrl.value = provider.baseUrl;
  elements.hostHeader.value = provider.headers['X-RapidAPI-Host'] ?? '';
  elements.epVisits.value = provider.endpoints.visits;
  elements.epGeo.value = provider.endpoints.geography;
  elements.apiKey.value = apiKey;
  elements.useMock.checked = Boolean(useMock);
}

// Requests an optional host permission for non-default providers. Must run
// inside a user gesture, which is why it lives in the submit handler.
async function ensureOptionalHostPermission(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return { granted: false, reason: 'invalid-url' };
  }

  if (isCoveredByStaticPermissions(origin)) {
    return { granted: true };
  }

  try {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    return { granted };
  } catch (error) {
    console.warn('Traffic-Stats: optional host permission request failed', error);
    return { granted: false, reason: 'request-failed' };
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  const form = readForm();
  const { valid, errors } = validateProviderInput(form);
  renderValidationErrors(errors);
  if (!valid) {
    setStatus('Fix the highlighted fields', 'error');
    return;
  }

  // A custom provider only works when the extension may reach its origin.
  const permission = await ensureOptionalHostPermission(form.baseUrl);

  try {
    await saveProviderConfig({
      provider: {
        name: 'RapidAPI Similarweb',
        baseUrl: form.baseUrl,
        endpoints: {
          visits: form.epVisits,
          geography: form.epGeo
        },
        headers: { 'X-RapidAPI-Host': form.hostHeader }
      },
      apiKey: form.apiKey,
      useMock: form.useMock
    });

    setStatus(permission.granted ? 'Saved ✓' : 'Saved — host access denied, live calls will fail', permission.granted ? 'ok' : 'error');
  } catch (error) {
    console.error('Traffic-Stats: unable to persist settings', error);
    setStatus('Save failed — see console', 'error');
  }
}

async function handleTestConnection() {
  elements.testButton.disabled = true;
  const originalLabel = elements.testButton.textContent;
  elements.testButton.textContent = 'Testing…';

  try {
    const startedAt = Date.now();
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.analyzeDomain,
      domain: 'example.com',
      bypassCache: true
    });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
    const source = response?.visits?.source ?? 'unknown';
    const error = response?.visits?.error ?? response?.geography?.error;

    if (source === 'api') {
      setStatus(`Live connection OK · ${elapsed}s`, 'ok');
    } else if (source === 'mock') {
      setStatus('Demo Mode active — live API not used', 'ok');
    } else {
      setStatus(`Provider error: ${error ?? 'unknown'}`, 'error');
    }
  } catch (error) {
    console.error('Traffic-Stats: connection test failed', error);
    setStatus('Connection test failed', 'error');
  } finally {
    elements.testButton.disabled = false;
    elements.testButton.textContent = originalLabel;
  }
}

async function handleReset() {
  const confirmed = window.confirm(
    'Restore the default provider configuration and remove the stored API key?'
  );
  if (!confirmed) return;

  await resetProviderConfig();
  await loadForm();
  renderValidationErrors([]);
  setStatus('Defaults restored', 'ok');
}

async function handleClearCache() {
  const removed = await clearAnalysisCache().catch(() => 0);
  setStatus(removed > 0 ? `Cleared ${removed} cached ${removed === 1 ? 'entry' : 'entries'}` : 'Cache already empty', 'ok');
}

elements.toggleKeyVisibility.addEventListener('click', () => {
  const showing = elements.apiKey.type === 'text';
  elements.apiKey.type = showing ? 'password' : 'text';
  elements.toggleKeyVisibility.textContent = showing ? 'Show' : 'Hide';
  elements.toggleKeyVisibility.setAttribute('aria-pressed', String(!showing));
});

elements.form.addEventListener('submit', (event) => void handleSubmit(event));
elements.testButton.addEventListener('click', () => void handleTestConnection());
elements.resetButton.addEventListener('click', () => void handleReset());
elements.clearCacheButton.addEventListener('click', () => void handleClearCache());

document.addEventListener('DOMContentLoaded', () => {
  void loadForm();
});
