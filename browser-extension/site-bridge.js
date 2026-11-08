// Runs in Chrome's ISOLATED world on the official website. It only reads two
// fixed same-origin endpoints, and never exposes the complete account response
// (or a page-callable bridge) to the extension or to website JavaScript.
(() => {
  'use strict';
  const onWebsite = () => window.top === window && location.origin === 'https://vrchat.com' &&
    (location.pathname === '/home' || location.pathname.startsWith('/home/'));
  if (!onWebsite()) return;

  const documentToken = crypto.randomUUID();
  const pending = new Map();
  const fields = ['friends', 'onlineFriends', 'activeFriends', 'offlineFriends'];
  const validId = value => typeof value === 'string' && !Object.hasOwn(Object.prototype, value) &&
    (/^usr_[a-zA-Z0-9_-]{1,100}$/.test(value) || /^[a-zA-Z0-9]{10}$/.test(value));
  const name = (value, id) => typeof value === 'string' && value.trim() ? value.slice(0, 160) : id;
  const failure = (kind, status = 0, retryAfter = '') => ({
    ok: false, documentToken, error: { kind, status, retryAfter },
  });

  function reducedUser(body) {
    if (!body || !validId(body.id)) throw new Error('format');
    const result = { id: body.id, displayName: name(body.displayName, body.id) };
    for (const field of fields) {
      if (!Array.isArray(body[field]) || body[field].length > 40_000 ||
          body[field].some(id => id !== null && !validId(id))) throw new Error('format');
      result[field] = body[field].filter(id => id !== null);
    }
    return result;
  }

  function reducedFriends(body) {
    if (!Array.isArray(body) || body.length > 100 || body.some(friend => !friend || !validId(friend.id))) {
      throw new Error('format');
    }
    return body.map(friend => ({ id: friend.id, displayName: name(friend.displayName, friend.id) }));
  }

  async function perform(message, controller) {
    const timeout = AbortSignal.timeout(20_000);
    const signal = AbortSignal.any([controller.signal, timeout]);
    const path = message.resource === 'currentUser' ? 'auth/user' :
      `auth/user/friends?offline=${message.offline}&n=100&offset=${message.offset}`;
    try {
      const response = await fetch('https://vrchat.com/api/1/' + path, {
        method: 'GET', mode: 'same-origin', credentials: 'same-origin',
        cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal,
      });
      if (!response.ok) return failure('http', response.status, (response.headers.get('Retry-After') || '').slice(0, 128));
      if (!response.headers.get('Content-Type')?.toLowerCase().includes('application/json')) return failure('format');
      const text = await response.text();
      if (text.length > 4 * 1024 * 1024) return failure('format');
      let body;
      try { body = JSON.parse(text); } catch { return failure('format'); }
      if (message.resource === 'currentUser' && Array.isArray(body?.requiresTwoFactorAuth) && body.requiresTwoFactorAuth.length) {
        return failure('http', 401);
      }
      let data;
      try { data = message.resource === 'currentUser' ? reducedUser(body) : reducedFriends(body); }
      catch { return failure('format'); }
      if (controller.signal.aborted) return failure('cancelled');
      if (!onWebsite()) return failure('site_changed');
      return { ok: true, documentToken, data };
    } catch {
      return failure(controller.signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'network');
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only this extension's worker can request reads. Content-script senders
    // have a tab; website scripts have no access to this isolated listener.
    if (sender.id !== chrome.runtime.id || sender.tab ||
        (sender.url && sender.url !== chrome.runtime.getURL('background.js')) ||
        (sender.origin && sender.origin !== `chrome-extension://${chrome.runtime.id}`)) return false;
    if (!message || !['vrc:site-ping', 'vrc:site-request', 'vrc:site-cancel'].includes(message.type)) return false;
    if (!onWebsite()) { sendResponse(failure('site_changed')); return false; }
    if (message.type === 'vrc:site-ping') {
      sendResponse({ ok: true, documentToken });
      return false;
    }
    if (message.documentToken !== documentToken) { sendResponse(failure('site_changed')); return false; }
    if (typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)) {
      sendResponse(failure('format')); return false;
    }
    if (message.type === 'vrc:site-cancel') {
      pending.get(message.id)?.abort();
      sendResponse({ ok: true, documentToken });
      return false;
    }
    const current = message.resource === 'currentUser';
    const friends = message.resource === 'friends' && typeof message.offline === 'boolean' &&
      Number.isInteger(message.offset) && message.offset >= 0 && message.offset <= 19_900 && message.offset % 100 === 0;
    const allowed = ['type', 'id', 'documentToken', 'resource', ...(friends ? ['offline', 'offset'] : [])];
    if ((!current && !friends) || Object.keys(message).some(key => !allowed.includes(key))) {
      sendResponse(failure('format')); return false;
    }
    if (pending.size) { sendResponse(failure('site_unavailable')); return false; }
    const controller = new AbortController();
    pending.set(message.id, controller);
    perform(message, controller).then(reply => {
      pending.delete(message.id);
      try { sendResponse(reply); } catch { /* The original document may have closed. */ }
    });
    return true;
  });
})();
