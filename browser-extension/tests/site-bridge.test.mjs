import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../site-bridge.js', import.meta.url), 'utf8');
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const DOCUMENT_TOKEN = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const OWNER = 'usr_demo_bridge_owner';
const FRIEND = 'usr_demo_bridge_friend';
const worker = {
  id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/background.js`,
  origin: `chrome-extension://${EXTENSION_ID}`,
};
const user = extra => ({
  id: OWNER, displayName: '模拟账号', friends: [FRIEND],
  onlineFriends: [FRIEND], activeFriends: [], offlineFriends: [], ...extra,
});
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const request = extra => ({
  type: 'vrc:site-request', id: REQUEST_ID, documentToken: DOCUMENT_TOKEN,
  resource: 'currentUser', ...extra,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness({
  url = 'https://vrchat.com/home/friends', top = true,
  fetchImpl = async () => json(user()), signalApi = AbortSignal,
} = {}) {
  const listeners = [];
  const calls = [];
  const location = new URL(url);
  const window = {};
  window.top = top ? window : {};
  const document = { baseURI: 'https://unrelated.example.invalid/changed-base/' };
  Object.defineProperty(document, 'cookie', { get() { throw new Error('Cookie access is forbidden in this fixture.'); } });
  const sandbox = {
    window, location, document, AbortController, AbortSignal: signalApi,
    crypto: { randomUUID: () => DOCUMENT_TOKEN },
    chrome: { runtime: {
      id: EXTENSION_ID, getURL: path => `chrome-extension://${EXTENSION_ID}/${path}`,
      onMessage: { addListener: listener => listeners.push(listener) },
    } },
    fetch: (url, options) => { calls.push({ url, options }); return fetchImpl(url, options); },
  };
  vm.runInNewContext(source, sandbox, { filename: 'site-bridge.js', timeout: 1000 });
  return {
    listeners, calls, location, window,
    deliver(message, sender = worker) {
      assert.equal(listeners.length, 1, 'the content script must register exactly one isolated listener');
      const completion = deferred();
      const replies = [];
      const keepAlive = listeners[0](message, sender, value => {
        // Capture the actual object before Chrome serializes it to JSON.
        replies.push(value);
        completion.resolve(value);
      });
      return { keepAlive, replies, response: completion.promise };
    },
  };
}

async function answer(site, message = request(), sender = worker) {
  const delivery = site.deliver(message, sender);
  const response = await delivery.response;
  // Browser messaging delivers the reply in another task. Allow the script's
  // settled-request cleanup to finish before simulating the next IPC request.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivery.replies.length, 1);
  return response;
}

function assertFailure(response, kind, status = 0) {
  assert.equal(response.ok, false);
  assert.equal(response.documentToken, DOCUMENT_TOKEN);
  assert.equal(response.error.kind, kind);
  assert.equal(response.error.status, status);
  assert.deepEqual(Object.keys(response).sort(), ['documentToken', 'error', 'ok']);
  assert.deepEqual(Object.keys(response.error).sort(), ['kind', 'retryAfter', 'status']);
}

test('bridge only registers on the official top-level home document', () => {
  for (const url of ['https://vrchat.com/home', 'https://vrchat.com/home/', 'https://vrchat.com/home/login?next=friends']) {
    assert.equal(harness({ url }).listeners.length, 1);
  }
  for (const url of [
    'http://vrchat.com/home/friends', 'https://vrchat.com.example.invalid/home/friends',
    'https://api.vrchat.cloud/home/friends', 'https://vrchat.com/',
    'https://vrchat.com/homepage', 'https://vrchat.com/api/1/auth/user',
  ]) {
    const site = harness({ url });
    assert.equal(site.listeners.length, 0, url);
    assert.equal(site.calls.length, 0);
  }
  assert.equal(harness({ top: false }).listeners.length, 0);
});

test('only this extension worker can invoke the isolated listener', async () => {
  const site = harness();
  for (const sender of [
    {}, { ...worker, id: 'another-extension' }, { ...worker, tab: { id: 1 } },
    { ...worker, url: 'https://vrchat.com/home/friends' },
    { ...worker, url: `chrome-extension://${EXTENSION_ID}/popup.html` },
    { ...worker, origin: 'https://vrchat.com' },
  ]) {
    const denied = site.deliver(request(), sender);
    assert.equal(denied.keepAlive, false);
    assert.equal(denied.replies.length, 0);
  }
  assert.equal(site.calls.length, 0);
  const ping = await answer(site, { type: 'vrc:site-ping' });
  assert.deepEqual(Object.keys(ping).sort(), ['documentToken', 'ok']);
  assert.equal(ping.documentToken, DOCUMENT_TOKEN);
  assert.equal(site.calls.length, 0);
  // Chrome's sender URL/origin fields are optional; the extension ID remains
  // mandatory even when those optional fields are absent.
  assert.equal((await answer(site, request(), { id: EXTENSION_ID })).ok, true);
});

test('every permitted read uses fixed same-origin GET options and ignores the document base URL', async () => {
  const site = harness({ fetchImpl: async url => url.includes('/friends?') ? json([]) : json(user()) });
  assert.equal((await answer(site)).ok, true);
  assert.equal((await answer(site, request({ resource: 'friends', offline: false, offset: 0 }))).ok, true);
  assert.equal((await answer(site, request({ resource: 'friends', offline: true, offset: 19_900 }))).ok, true);
  assert.deepEqual(site.calls.map(call => call.url), [
    'https://vrchat.com/api/1/auth/user',
    'https://vrchat.com/api/1/auth/user/friends?offline=false&n=100&offset=0',
    'https://vrchat.com/api/1/auth/user/friends?offline=true&n=100&offset=19900',
  ]);
  for (const { options } of site.calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.signal instanceof AbortSignal, true);
  }
});

test('arbitrary request parameters and out-of-range pagination never reach fetch', async () => {
  const site = harness();
  const invalid = [
    request({ resource: 'https://unrelated.example.invalid/' }), request({ resource: 'logout' }),
    request({ path: 'auth/user' }), request({ url: 'https://vrchat.com/api/1/auth/user' }),
    request({ method: 'POST' }), request({ headers: { Authorization: 'synthetic-only' } }),
    request({ body: '{}' }), request({ offline: false, offset: 0 }), request({ id: 'invalid' }),
    request({ resource: 'friends', offline: false, offset: 0, n: 200 }),
  ];
  for (const offset of [-100, 1, 99, 100.5, 19_901, 20_000, '100', null, undefined]) {
    invalid.push(request({ resource: 'friends', offline: false, offset }));
  }
  for (const offline of ['false', 0, null, undefined]) {
    invalid.push(request({ resource: 'friends', offline, offset: 0 }));
  }
  for (const message of invalid) assertFailure(await answer(site, message), 'format');
  assertFailure(await answer(site, request({ documentToken: 'stale-document' })), 'site_changed');
  for (const message of [null, {}, { type: 'fetch' }]) {
    const ignored = site.deliver(message);
    assert.equal(ignored.keepAlive, false);
    assert.equal(ignored.replies.length, 0);
  }
  assert.equal(site.calls.length, 0);
});

test('account and roster fields are reduced before any JSON message crosses the bridge', async () => {
  const privateFields = {
    authToken: 'synthetic-account-secret', email: 'synthetic-secret@example.invalid',
    location: 'synthetic-private-location', password: 'synthetic-unused-password',
    twoFactorAuth: { secret: 'synthetic-factor-secret' },
  };
  const site = harness({ fetchImpl: async url => url.includes('/friends?') ? json([
    { id: FRIEND, displayName: 'x'.repeat(200), ...privateFields },
    { id: 'usr_demo_bridge_other', displayName: '  ', ...privateFields },
  ]) : json(user({ friends: [FRIEND, null], onlineFriends: [null, FRIEND], ...privateFields })) });
  const account = await answer(site);
  assert.equal(account.ok, true);
  assert.deepEqual(Object.keys(account).sort(), ['data', 'documentToken', 'ok']);
  assert.deepEqual(Object.keys(account.data).sort(), ['activeFriends', 'displayName', 'friends', 'id', 'offlineFriends', 'onlineFriends']);
  assert.deepEqual(Array.from(account.data.friends), [FRIEND]);
  assert.deepEqual(Array.from(account.data.onlineFriends), [FRIEND]);
  const roster = await answer(site, request({ resource: 'friends', offline: false, offset: 0 }));
  assert.equal(roster.ok, true);
  assert.equal(roster.data[0].displayName.length, 160);
  assert.equal(roster.data[1].displayName, 'usr_demo_bridge_other');
  for (const friend of roster.data) assert.deepEqual(Object.keys(friend).sort(), ['displayName', 'id']);
  const serialized = JSON.stringify([account, roster]);
  for (const field of Object.keys(privateFields)) assert.equal(serialized.includes(field), false, field);
  for (const secret of Object.values(privateFields).filter(value => typeof value === 'string')) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('2FA challenges and HTTP failures expose safe status and bounded Retry-After only', async () => {
  const challenge = harness({ fetchImpl: async () => json({ requiresTwoFactorAuth: ['totp'], secret: 'synthetic-factor-secret' }) });
  assertFailure(await answer(challenge), 'http', 401);
  for (const [status, retryAfter] of [[403, ''], [429, '900'], [429, 'Wed, 14 Oct 2026 12:00:00 GMT'], [429, '9'.repeat(200)]]) {
    let bodyReads = 0;
    const site = harness({ fetchImpl: async () => ({
      ok: false, status,
      headers: new Headers({ 'Retry-After': retryAfter }),
      text: async () => { bodyReads++; return 'synthetic-private-server-diagnostic'; },
    }) });
    const response = await answer(site);
    assertFailure(response, 'http', status);
    assert.equal(response.error.retryAfter, retryAfter.slice(0, 128));
    assert.equal(bodyReads, 0);
    assert.equal(JSON.stringify(response).includes('synthetic-private-server-diagnostic'), false);
  }
});

test('HTML, invalid JSON, oversized responses and invalid schemas never become account data', async () => {
  const responses = [
    () => new Response('<html>synthetic-private-page</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{synthetic-invalid-json', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(' '.repeat(4 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
    () => json(null), () => json(user({ id: '__proto__' })),
    () => json(user({ friends: undefined })), () => json(user({ onlineFriends: ['malformed'] })),
    () => json(user({ activeFriends: [3] })),
    () => json(user({ friends: Array(40_001).fill(FRIEND) })),
  ];
  for (const fetchImpl of responses) assertFailure(await answer(harness({ fetchImpl })), 'format');
  for (const body of [{}, [null], [{ id: '__proto__' }], Array.from({ length: 101 }, () => ({ id: FRIEND }))]) {
    const site = harness({ fetchImpl: async () => json(body) });
    assertFailure(await answer(site, request({ resource: 'friends', offline: true, offset: 0 })), 'format');
  }
});

test('cancellation aborts its request and a late successful response cannot leak a snapshot', async () => {
  const network = deferred();
  const site = harness({ fetchImpl: () => network.promise });
  const pending = site.deliver(request());
  assert.equal(pending.keepAlive, true);
  assert.equal(site.calls[0].options.signal.aborted, false);
  assertFailure(await answer(site, request({ id: OTHER_REQUEST_ID })), 'site_unavailable');
  assert.equal(site.calls.length, 1);
  const cancelled = await answer(site, { type: 'vrc:site-cancel', documentToken: DOCUMENT_TOKEN, id: REQUEST_ID });
  assert.equal(cancelled.ok, true);
  assert.equal(site.calls[0].options.signal.aborted, true);
  // This fetch fixture deliberately ignores AbortSignal to simulate a reply
  // that was already in transit when cancellation reached the document.
  network.resolve(json(user()));
  assertFailure(await pending.response, 'cancelled');
  assert.equal(pending.replies.length, 1);
});

test('navigating away before the body arrives rejects both late data and future reads', async () => {
  const body = deferred();
  const site = harness({ fetchImpl: async () => ({
    ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }),
    text: () => body.promise,
  }) });
  const pending = site.deliver(request());
  site.location.pathname = '/unrelated-page';
  body.resolve(JSON.stringify(user()));
  assertFailure(await pending.response, 'site_changed');
  assertFailure(await answer(site, { type: 'vrc:site-ping' }), 'site_changed');
  assertFailure(await answer(site), 'site_changed');
  assert.equal(site.calls.length, 1);
});

test('abort deadlines and network failures return classifications without exception details', async () => {
  const timeout = new AbortController();
  const durations = [];
  const site = harness({
    signalApi: { timeout: ms => { durations.push(ms); return timeout.signal; }, any: signals => AbortSignal.any(signals) },
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const pending = site.deliver(request());
  timeout.abort(new DOMException('synthetic-private-timeout-detail', 'TimeoutError'));
  assertFailure(await pending.response, 'timeout');
  assert.deepEqual(durations, [20_000]);
  const failed = harness({ fetchImpl: async () => { throw new TypeError('synthetic-private-network-detail'); } });
  const failure = await answer(failed);
  assertFailure(failure, 'network');
  assert.equal(JSON.stringify(failure).includes('synthetic-private-network-detail'), false);
});
