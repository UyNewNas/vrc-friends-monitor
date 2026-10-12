import { ApiError, parseRetryAfter } from './api.js';

const HOME_PATTERN = 'https://vrchat.com/home*';
const TOKEN = /^[a-f0-9-]{36}$/;
const ERROR_KINDS = new Set(['http', 'format', 'network', 'timeout', 'cancelled', 'site_changed', 'site_unavailable']);

function websiteTab(tab) {
  try {
    const url = new URL(tab.url);
    return Number.isInteger(tab.id) && !tab.incognito && url.origin === 'https://vrchat.com' &&
      (url.pathname === '/home' || url.pathname.startsWith('/home/'));
  } catch { return false; }
}

const aborted = signal => new ApiError(signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');

// Chrome messages are JSON values, not Response/Map/AbortSignal objects. Pin
// the selected top-level document for the complete monitor operation, so pages
// from different documents cannot be combined into one friend's snapshot.
export function createWebsiteRequest(browser, { now = Date.now } = {}) {
  const sessions = new WeakMap();

  function send(tabId, message, signal, timeoutMs = 22_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      const stopRequest = () => {
        if (message.type !== 'vrc:site-request') return;
        Promise.resolve().then(() => browser.tabs.sendMessage(tabId, {
          type: 'vrc:site-cancel', id: message.id, documentToken: message.documentToken,
        }, { frameId: 0 })).catch(() => {});
      };
      const cancel = () => { stopRequest(); finish(aborted(signal)); };
      const timer = setTimeout(() => { stopRequest(); finish(new ApiError('site_unavailable')); }, timeoutMs);
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      Promise.resolve().then(() => {
        if (settled) return undefined;
        return browser.tabs.sendMessage(tabId, message, { frameId: 0 });
      }).then(
        reply => finish(null, reply),
        () => finish(new ApiError('site_unavailable')),
      );
    });
  }

  async function selectDocument(signal) {
    if (signal?.aborted) throw aborted(signal);
    let tabs;
    try { tabs = (await browser.tabs.query({ url: HOME_PATTERN })).filter(websiteTab); }
    catch { throw new ApiError('site_unavailable'); }
    if (!tabs.length) throw new ApiError('site_required');
    const candidates = tabs.filter(tab => !tab.discarded && !tab.frozen && tab.status === 'complete')
      .sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (!candidates.length) throw new ApiError('site_unavailable');
    for (const tab of candidates.slice(0, 5)) {
      try {
        const reply = await send(tab.id, { type: 'vrc:site-ping' }, signal, 2000);
        if (reply?.ok === true && typeof reply.documentToken === 'string' && TOKEN.test(reply.documentToken)) {
          return { tabId: tab.id, documentToken: reply.documentToken };
        }
      } catch (error) {
        if (signal?.aborted) throw aborted(signal);
        if (!['site_unavailable', 'site_changed'].includes(error.kind)) throw error;
      }
    }
    // Static content scripts are not injected retroactively into old tabs when
    // an unpacked extension is installed or reloaded. A normal page reload is
    // required; opening a new official page also creates a fresh document.
    throw new ApiError('site_reload_required');
  }

  async function documentFor(signal) {
    if (!signal) return selectDocument();
    if (!sessions.has(signal)) sessions.set(signal, selectDocument(signal));
    return sessions.get(signal);
  }

  return async function request(path, signal) {
    if (signal?.aborted) throw aborted(signal);
    let operation;
    if (path === 'auth/user') operation = { resource: 'currentUser' };
    else {
      const match = /^auth\/user\/friends\?offline=(true|false)&n=100&offset=(0|[1-9]\d{0,4})$/.exec(path);
      const offset = match ? Number(match[2]) : -1;
      if (!match || offset > 19_900 || offset % 100 !== 0) throw new ApiError('format');
      operation = { resource: 'friends', offline: match[1] === 'true', offset };
    }
    const session = await documentFor(signal);
    const reply = await send(session.tabId, {
      type: 'vrc:site-request', id: crypto.randomUUID(), documentToken: session.documentToken, ...operation,
    }, signal);
    if (signal?.aborted) throw aborted(signal);
    if (!reply || reply.documentToken !== session.documentToken) throw new ApiError('site_changed');
    if (reply.ok !== true) {
      const error = reply.error;
      if (!error || !ERROR_KINDS.has(error.kind)) throw new ApiError('format');
      if (error.kind === 'http') {
        if (!Number.isInteger(error.status) || error.status < 400 || error.status > 599) throw new ApiError('format');
        const retry = typeof error.retryAfter === 'string' && error.retryAfter.length <= 128 ? error.retryAfter : '';
        throw new ApiError('http', error.status, parseRetryAfter(retry, now()));
      }
      throw new ApiError(error.kind);
    }
    return reply.data;
  };
}
