import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError, API_BASE, parseRetryAfter } from '../api.js';
import { readIdentity, makeSnapshot, changesBetween } from '../core.js';

const user = extra => ({
  id: 'usr_demo_account', displayName: '模拟账号', friends: ['usr_demo_one', 'usr_demo_two'],
  onlineFriends: ['usr_demo_one', null], activeFriends: ['usr_demo_two'], offlineFriends: [], ...extra,
});
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

test('same website API uses browser credentials and drops unrelated account fields', async () => {
  const calls = [];
  const api = createApi({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return json(user({ authToken: 'synthetic-only', email: 'demo@example.invalid' }));
  } });
  const identity = await api.currentUser();
  assert.equal(calls[0].url, API_BASE + 'auth/user');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.deepEqual(calls[0].options.headers, { Accept: 'application/json' });
  assert.deepEqual(Object.keys(identity).sort(), ['id', 'name', 'states']);
  assert.equal(identity.states.get('usr_demo_one'), 'game');
  assert.equal(identity.states.get('usr_demo_two'), 'web');
});

test('incomplete / contradictory membership never becomes an empty or offline snapshot', () => {
  for (const patch of [
    { friends: null }, { activeFriends: undefined }, { offlineFriends: {} },
    { offlineFriends: ['usr_demo_one'] }, { friends: ['usr_demo_two'] },
    { friends: ['usr_demo_one', 'usr_demo_two', 'usr_demo_missing'] },
    { onlineFriends: ['malformed'] },
  ]) assert.throws(() => readIdentity(user(patch)));
  assert.equal(readIdentity(user({ friends: [], onlineFriends: [], activeFriends: [], offlineFriends: [] })).states.size, 0);
});

test('website or other non-game activity does not count as a game login', () => {
  const before = [{ id: 'usr_demo_one', name: '模拟好友', state: 'offline' }];
  const web = [{ ...before[0], state: 'web' }];
  const game = [{ ...before[0], state: 'game' }];
  assert.deepEqual(changesBetween(before, web, 1), []);
  assert.equal(changesBetween(web, game, 2)[0].online, true);
  assert.equal(changesBetween(game, web, 3)[0].online, false);
  assert.deepEqual(changesBetween([], game, 4), []);
  assert.deepEqual(changesBetween(game, [], 5), []);
  assert.deepEqual(changesBetween(game, game, 6), []);
});

test('snapshots use authoritative membership and keep known names until roster renewal', () => {
  const identity = readIdentity(user());
  const snapshot = makeSnapshot(identity,
    [{ id: 'usr_demo_one', name: '新显示名称' }, { id: 'usr_demo_removed', name: '已删除好友' }],
    [{ id: 'usr_demo_two', name: '旧显示名称', state: 'offline' }]);
  assert.deepEqual(snapshot, [
    { id: 'usr_demo_one', name: '新显示名称', state: 'game' },
    { id: 'usr_demo_two', name: '旧显示名称', state: 'web' },
  ]);
});

test('rate limits preserve seconds and HTTP-date Retry-After without returning server text', async () => {
  const now = Date.UTC(2026, 9, 12, 0, 0);
  assert.equal(parseRetryAfter('120', now), 120000);
  assert.equal(parseRetryAfter(new Date(now + 3600000).toUTCString(), now), 3600000);
  assert.equal(parseRetryAfter('nonsense', now), 0);
  const api = createApi({ now: () => now, fetchImpl: async () => json({ error: { message: 'private diagnostic body' } }, 429, { 'Retry-After': '900' }) });
  await assert.rejects(api.currentUser(), error => error instanceof ApiError &&
    error.status === 429 && error.retryAfterMs === 900000 && !error.message.includes('private'));
});

test('login challenges, HTML pages and invalid JSON produce safe classified errors', async () => {
  const scenarios = [
    [() => json({ requiresTwoFactorAuth: ['totp'] }), 'http', 401],
    [() => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }), 'format', 0],
    [() => new Response('{', { headers: { 'Content-Type': 'application/json' } }), 'format', 0],
    [() => new Response('denied', { status: 403 }), 'http', 403],
    [() => { throw new TypeError('private network detail'); }, 'network', 0],
  ];
  for (const [response, kind, status] of scenarios) {
    const api = createApi({ fetchImpl: async () => response() });
    await assert.rejects(api.currentUser(), error => error.kind === kind && error.status === status);
  }
});

test('friend roster follows both paginated lists and never leaks complete API objects', async () => {
  const calls = [];
  const first = Array.from({ length: 100 }, (_, i) => ({ id: `usr_demo_${i}`, displayName: `模拟${i}`, email: 'unused@example.invalid' }));
  const responses = [first, [{ id: 'usr_demo_tail', displayName: '末页' }], [{ id: 'usr_demo_offline', displayName: '离线好友' }]];
  const api = createApi({ wait: async () => {}, fetchImpl: async url => { calls.push(url); return json(responses.shift()); } });
  const result = await api.friends();
  assert.equal(result.length, 102);
  assert.deepEqual(calls.map(url => new URL(url).search), [
    '?offline=false&n=100&offset=0', '?offline=false&n=100&offset=100', '?offline=true&n=100&offset=0',
  ]);
  assert.deepEqual(Object.keys(result[0]).sort(), ['id', 'name']);
});

test('repeated or malformed roster pages fail the whole sync', async () => {
  const repeated = Array.from({ length: 100 }, (_, i) => ({ id: `usr_demo_${i}` }));
  const api = createApi({ wait: async () => {}, fetchImpl: async () => json(repeated) });
  await assert.rejects(api.friends(), error => error.kind === 'pagination');
  const broken = createApi({ fetchImpl: async () => json([{ id: null }]) });
  await assert.rejects(broken.friends(), error => error.kind === 'format');
});

test('user cancellation and an operation deadline remain distinct', async () => {
  const api = createApi({ fetchImpl: async (_url, options) => { throw options.signal.reason; } });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(api.currentUser(cancelled.signal), error => error.kind === 'cancelled');
  const deadline = new AbortController(); deadline.abort(new DOMException('deadline', 'TimeoutError'));
  await assert.rejects(api.currentUser(deadline.signal), error => error.kind === 'timeout');
});
