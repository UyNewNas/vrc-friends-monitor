import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebsiteRequest } from '../session.js';
import { createApi } from '../api.js';

const documentA = '00000000-0000-4000-8000-000000000001';
const documentB = '00000000-0000-4000-8000-000000000002';
const identity = {
  id: 'usr_demo_account', displayName: '模拟账号', friends: ['usr_demo_one'],
  onlineFriends: ['usr_demo_one'], activeFriends: [], offlineFriends: [],
};
const signal = () => new AbortController().signal;

function fixture() {
  const f = {
    tabs: [{ id: 10, url: 'https://vrchat.com/home', active: true, status: 'complete' }],
    token: documentA, calls: [], queries: 0,
    handle: async (_tabId, message) => ({
      ok: true, documentToken: f.token,
      ...(message.type === 'vrc:site-request' ? { data: message.resource === 'currentUser' ? identity : [] } : {}),
    }),
  };
  f.browser = { tabs: {
    query: async options => { assert.equal(options.url, 'https://vrchat.com/home*'); f.queries++; return structuredClone(f.tabs); },
    sendMessage: async (tabId, message, options) => {
      assert.deepEqual(options, { frameId: 0 });
      f.calls.push({ tabId, message: structuredClone(message) });
      // Deliberately use Chrome's JSON boundary, not structuredClone for replies.
      return JSON.parse(JSON.stringify(await f.handle(tabId, message)));
    },
  } };
  f.request = createWebsiteRequest(f.browser, { now: () => Date.UTC(2026, 9, 12) });
  return f;
}

test('a complete operation pins one top-level website document and reconstructs JSON presence', async () => {
  const f = fixture(); const operation = signal();
  const api = createApi({ requestImpl: f.request });
  const account = await api.currentUser(operation);
  assert.equal(account.states.get('usr_demo_one'), 'game');
  f.tabs = [{ id: 20, url: 'https://vrchat.com/home/friends', active: true, status: 'complete' }];
  await api.friends(operation);
  await api.currentUser(operation);
  assert.equal(f.queries, 1);
  assert.ok(f.calls.every(call => call.tabId === 10));
  assert.equal(f.calls.filter(call => call.message.type === 'vrc:site-ping').length, 1);
  assert.deepEqual(f.calls.filter(call => call.message.resource === 'friends').map(call =>
    [call.message.offline, call.message.offset]), [[false, 0], [true, 0]]);
  await api.currentUser(signal());
  assert.equal(f.calls.at(-1).tabId, 20);
});

test('closed or replaced documents fail the pinned sync instead of switching tabs', async () => {
  const f = fixture(); const operation = signal();
  await f.request('auth/user', operation);
  f.token = documentB;
  await assert.rejects(f.request('auth/user', operation), error => error.kind === 'site_changed');
  f.handle = async () => { throw new Error('synthetic browser channel closed'); };
  await assert.rejects(f.request('auth/user', operation), error => error.kind === 'site_unavailable');
  assert.equal(f.queries, 1);
});

test('missing, old and suspended website tabs have distinct actionable errors', async () => {
  const f = fixture();
  f.tabs = [];
  await assert.rejects(f.request('auth/user', signal()), error => error.kind === 'site_required');
  f.tabs = [{ id: 10, url: 'https://vrchat.com/home', status: 'complete' }];
  f.handle = async () => { throw new Error('synthetic missing receiver'); };
  await assert.rejects(f.request('auth/user', signal()), error => error.kind === 'site_reload_required');
  for (const patch of [{ discarded: true }, { frozen: true }, { status: 'loading' }]) {
    f.tabs = [{ id: 10, url: 'https://vrchat.com/home', status: 'complete', ...patch }];
    await assert.rejects(f.request('auth/user', signal()), error => error.kind === 'site_unavailable');
  }
  assert.ok(f.calls.every(call => call.message.type === 'vrc:site-ping'));
});

test('tab discovery rejects wrong origins, misleading paths and incognito documents', async () => {
  const f = fixture();
  f.tabs = [
    { id: 1, url: 'https://vrchat.com.invalid/home' },
    { id: 2, url: 'https://vrchat.com/homepage' },
    { id: 3, url: 'http://vrchat.com/home' },
    { id: 4, url: 'https://vrchat.com/home', incognito: true },
  ].map(tab => ({ status: 'complete', ...tab }));
  await assert.rejects(f.request('auth/user', signal()), error => error.kind === 'site_required');
  assert.equal(f.calls.length, 0);
});

test('invalid endpoint or pagination cannot make any tab or network request', async () => {
  const f = fixture();
  for (const path of [
    'https://other.invalid/', 'auth/user?x=1', 'auth/user/../token',
    'auth/user/friends?offline=true&n=100&offset=20000',
    'auth/user/friends?offline=true&n=100&offset=1',
    'auth/user/friends?offline=false&n=101&offset=0',
    'auth/user/friends?offline=false&n=100&offset=0&extra=yes',
  ]) await assert.rejects(f.request(path, signal()), error => error.kind === 'format');
  assert.equal(f.queries, 0);
  assert.equal(f.calls.length, 0);
});

test('HTTP status and Retry-After cross the bridge as sanitized errors', async () => {
  const f = fixture();
  f.handle = async (_tab, message) => message.type === 'vrc:site-ping' ? { ok: true, documentToken: documentA } : {
    ok: false, documentToken: documentA,
    error: { kind: 'http', status: 429, retryAfter: '900', ignoredMessage: 'synthetic-private' },
  };
  await assert.rejects(f.request('auth/user', signal()), error =>
    error.status === 429 && error.retryAfterMs === 900000 && !JSON.stringify(error).includes('synthetic-private'));
  f.handle = async (_tab, message) => message.type === 'vrc:site-ping' ? { ok: true, documentToken: documentA } : {
    ok: false, documentToken: documentA, error: { kind: 'http', status: '403', retryAfter: '900' },
  };
  await assert.rejects(f.request('auth/user', signal()), error => error.kind === 'format');
});

test('cancellation closes the page-side request and ignores a late response', async () => {
  const f = fixture(); const controller = new AbortController();
  let finishRequest; let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  f.handle = async (_tab, message) => {
    if (message.type !== 'vrc:site-request') return { ok: true, documentToken: documentA };
    markStarted();
    return new Promise(resolve => { finishRequest = resolve; });
  };
  const pending = f.request('auth/user', controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, error => error.kind === 'cancelled');
  assert.equal(f.calls.at(-1).message.type, 'vrc:site-cancel');
  assert.equal(f.calls.at(-1).message.id, f.calls.at(-2).message.id);
  finishRequest({ ok: true, documentToken: documentA, data: identity });
  const count = f.calls.length;
  await assert.rejects(f.request('auth/user', controller.signal), error => error.kind === 'cancelled');
  assert.equal(f.calls.length, count);
  const deadline = new AbortController(); deadline.abort(new DOMException('synthetic deadline', 'TimeoutError'));
  await assert.rejects(f.request('auth/user', deadline.signal), error => error.kind === 'timeout');
});
