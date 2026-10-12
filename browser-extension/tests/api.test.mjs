import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError, parseRetryAfter } from '../api.js';
import { readIdentity, makeSnapshot, changesBetween } from '../core.js';

const user = extra => ({
  id: 'usr_demo_account', displayName: '模拟账号', friends: ['usr_demo_one', 'usr_demo_two'],
  onlineFriends: ['usr_demo_one', null], activeFriends: ['usr_demo_two'], offlineFriends: [], ...extra,
});
test('website transport returns only reduced account fields and reconstructs state maps', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const api = createApi({ requestImpl: async (path, receivedSignal) => {
    calls.push({ path, receivedSignal });
    return user({ fixturePrivateField: 'synthetic-only', email: 'demo@example.invalid' });
  } });
  const identity = await api.currentUser(signal);
  assert.equal(calls[0].path, 'auth/user');
  assert.equal(calls[0].receivedSignal, signal);
  assert.deepEqual(Object.keys(identity).sort(), ['id', 'name', 'states']);
  assert.equal(identity.states.get('usr_demo_one'), 'game');
  assert.equal(identity.states.get('usr_demo_two'), 'web');
});

test('missing array fields or malformed identifiers never become a healthy snapshot', () => {
  for (const patch of [
    { friends: null }, { activeFriends: undefined }, { offlineFriends: {} },
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
  const api = createApi({ requestImpl: async () => { throw new ApiError('http', 429, 900000); } });
  await assert.rejects(api.currentUser(), error => error instanceof ApiError &&
    error.status === 429 && error.retryAfterMs === 900000);
});

test('login challenges and incomplete identities are classified safely', async () => {
  const challenge = createApi({ requestImpl: async () => ({ requiresTwoFactorAuth: ['totp'] }) });
  await assert.rejects(challenge.currentUser(), error => error.kind === 'http' && error.status === 401);
  const invalid = createApi({ requestImpl: async () => ({ id: 'usr_demo_account' }) });
  await assert.rejects(invalid.currentUser(), error => error.kind === 'format');
});

test('friend roster follows both paginated lists and never leaks complete API objects', async () => {
  const calls = [];
  const first = Array.from({ length: 100 }, (_, i) => ({ id: `usr_demo_${i}`, displayName: `模拟${i}`, email: 'unused@example.invalid' }));
  const responses = [first, [{ id: 'usr_demo_tail', displayName: '末页' }], [{ id: 'usr_demo_offline', displayName: '离线好友' }]];
  const api = createApi({ wait: async () => {}, requestImpl: async path => { calls.push(path); return responses.shift(); } });
  const result = await api.friends();
  assert.equal(result.length, 102);
  assert.deepEqual(calls.map(path => '?' + path.split('?')[1]), [
    '?offline=false&n=100&offset=0', '?offline=false&n=100&offset=100', '?offline=true&n=100&offset=0',
  ]);
  assert.deepEqual(Object.keys(result[0]).sort(), ['id', 'name']);
});

test('repeated or malformed roster pages fail the whole sync', async () => {
  const repeated = Array.from({ length: 100 }, (_, i) => ({ id: `usr_demo_${i}` }));
  const api = createApi({ wait: async () => {}, requestImpl: async () => repeated });
  await assert.rejects(api.friends(), error => error.kind === 'pagination');
  const broken = createApi({ requestImpl: async () => [{ id: null }] });
  await assert.rejects(broken.friends(), error => error.kind === 'format');
});

test('pagination stops requesting new pages after operation cancellation', async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = createApi({
    requestImpl: async () => {
      calls++;
      return Array.from({ length: 100 }, (_, index) => ({ id: `usr_demo_${index}` }));
    },
    wait: async () => controller.abort(),
  });
  await assert.rejects(api.friends(controller.signal), error => error.kind === 'cancelled');
  assert.equal(calls, 1);
});
