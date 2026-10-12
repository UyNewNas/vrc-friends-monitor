import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi } from '../api.js';
import { MINUTE, ROSTER_INTERVAL, emptyState, isUserId, readIdentity } from '../core.js';
import { Monitor } from '../monitor.js';

// Synthetic identities only. These scenarios exercise persisted state across
// distinct worker instances; they do not use a browser session or network.
const T0 = Date.UTC(2026, 9, 12, 0, 0);
const OWNER_A = 'usr_synthetic_account_a';
const OWNER_B = 'usr_synthetic_account_b';
const FRIEND = 'usr_synthetic_friend';

function payload(owner = OWNER_A, presence = 'offline') {
  return {
    id: owner,
    displayName: owner === OWNER_A ? 'Synthetic account A' : 'Synthetic account B',
    friends: [FRIEND],
    onlineFriends: presence === 'game' ? [FRIEND] : [],
    activeFriends: presence === 'web' ? [FRIEND] : [],
    offlineFriends: presence === 'offline' ? [FRIEND] : [],
  };
}

function connectedState(presence = 'offline') {
  const state = emptyState();
  state.activeAccountId = OWNER_A;
  state.accounts[OWNER_A] = {
    id: OWNER_A, name: 'Synthetic account A',
    friends: [{ id: FRIEND, name: 'Synthetic friend', state: presence }],
    rules: { [FRIEND]: { online: true, offline: true } },
    events: [], lastSyncAt: T0, rosterSyncedAt: T0,
  };
  state.connection = {
    status: 'connected', message: 'Connected', stale: false,
    lastSuccessAt: T0, lastAttemptAt: T0, nextAttemptAt: T0 + MINUTE,
    failures: 0, retryUntil: 0,
  };
  return state;
}

function harness({ saved = connectedState(), api: externalApi } = {}) {
  let disk = structuredClone(saved);
  let clock = T0 + MINUTE;
  const notices = [];
  const deadlines = [];
  const calls = { current: 0, roster: 0 };
  const source = { raw: payload(), current: null, roster: null };
  const api = externalApi ?? {
    async currentUser(signal) {
      calls.current++;
      return source.current ? source.current(signal) : readIdentity(source.raw);
    },
    async friends(signal) {
      calls.roster++;
      return source.roster ? source.roster(signal) : [{ id: FRIEND, name: 'Synthetic friend' }];
    },
  };
  return {
    source, calls, notices, deadlines,
    get now() { return clock; },
    get disk() { return structuredClone(disk); },
    advance(ms) { clock += ms; },
    setTime(time) { clock = time; },
    worker() {
      return new Monitor({
        api,
        load: async () => structuredClone(disk),
        save: async state => { disk = structuredClone(state); },
        schedule: async deadline => { deadlines.push(deadline); },
        notify: async change => { notices.push(structuredClone(change)); },
        now: () => clock,
      });
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function response(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

test('ordinary worker suspension preserves the baseline and never replays a saved notification', async () => {
  const h = harness();
  h.source.raw = payload(OWNER_A, 'game');
  let worker = h.worker();
  await worker.recover();
  await worker.tick();
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].online, true);

  worker = h.worker();
  await worker.recover();
  await worker.tick();
  assert.equal(h.calls.current, 1, 'restart before the next deadline must not make another request');
  assert.equal(h.notices.length, 1);

  h.advance(MINUTE);
  h.source.raw = payload(OWNER_A, 'offline');
  await worker.tick();
  assert.deepEqual(h.notices.map(event => event.online), [true, false]);
  assert.equal(h.disk.accounts[OWNER_A].events.length, 2);
});

test('a browser cold start establishes a silent baseline before reporting later transitions', async () => {
  const h = harness();
  h.setTime(T0 + 60 * MINUTE);
  h.source.raw = payload(OWNER_A, 'game');
  const worker = h.worker();
  await worker.recover({ startup: true });
  await worker.tick();
  assert.equal(h.notices.length, 0);
  assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'game');

  h.advance(MINUTE);
  h.source.raw = payload(OWNER_A, 'offline');
  await worker.tick();
  assert.deepEqual(h.notices.map(event => event.online), [false]);
  assert.equal(h.notices[0].at, h.now, 'events record observation time, not an invented time during the gap');
});

test('an interrupted synchronization cannot announce transitions from an unfinished observation', async () => {
  const saved = connectedState();
  saved.connection.status = 'syncing';
  saved.connection.lastAttemptAt = T0 + MINUTE;
  const h = harness({ saved });
  h.source.raw = payload(OWNER_A, 'game');
  const worker = h.worker();
  await worker.recover();
  await worker.tick();
  assert.equal(h.notices.length, 0);
  assert.equal(h.disk.connection.status, 'connected');
  assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'game');
});

test('server backoff survives refresh, pause/resume, and worker or browser restarts', async () => {
  const h = harness();
  h.source.current = async () => { throw new ApiError('http', 429, 7 * MINUTE); };
  let worker = h.worker();
  await worker.tick();
  const deadline = h.now + 7 * MINUTE;
  assert.equal(h.disk.connection.retryUntil, deadline);
  h.source.current = null;
  h.source.raw = payload(OWNER_A, 'game');

  h.advance(31_000);
  await worker.tick({ manual: true });
  await worker.updateSettings({ enabled: false });
  await worker.tick({ manual: true });
  await worker.updateSettings({ enabled: true });
  worker = h.worker();
  await worker.recover({ startup: true });
  await worker.tick({ manual: true });
  h.setTime(deadline - 1);
  await worker.tick();
  assert.equal(h.calls.current, 1, 'no control or restart may bypass the server deadline');

  h.setTime(deadline);
  await worker.tick();
  assert.equal(h.calls.current, 2);
  assert.equal(h.disk.connection.retryUntil, 0);
  assert.equal(h.notices.length, 0, 'the first successful observation after a failure is a new baseline');
});

test('a network failure keeps the cached online state and recovery does not fabricate a logout', async () => {
  const h = harness({ saved: connectedState('game') });
  h.source.current = async () => { throw new ApiError('http', 503); };
  const worker = h.worker();
  await worker.tick();
  assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'game');
  assert.equal((await worker.getState()).connection.stale, true);
  assert.equal(h.notices.length, 0);

  h.source.current = null;
  h.source.raw = payload(OWNER_A, 'offline');
  h.advance(MINUTE);
  await worker.tick();
  assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'offline');
  assert.equal(h.notices.length, 0);

  h.source.raw = payload(OWNER_A, 'game');
  h.advance(MINUTE);
  await worker.tick();
  assert.deepEqual(h.notices.map(event => event.online), [true]);
});

for (const [name, mutate] of [
  ['a missing array', raw => { delete raw.offlineFriends; }],
  ['conflicting online/offline membership', raw => { raw.onlineFriends = [FRIEND]; }],
  ['a friend absent from every presence array', raw => { raw.offlineFriends = []; }],
]) {
  test(`API schema failure with ${name} preserves the last complete snapshot`, async () => {
    const raw = payload();
    mutate(raw);
    let requests = 0;
    const api = createApi({ fetchImpl: async () => { requests++; return response(raw); } });
    const h = harness({ api, saved: connectedState('game') });
    const worker = h.worker();
    await worker.tick();
    assert.equal(requests, 1);
    assert.equal(h.disk.connection.status, 'retrying');
    assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'game');
    assert.deepEqual(h.disk.accounts[OWNER_A].events, []);
    assert.deepEqual(h.notices, []);
  });
}

test('an HTTP 200 two-factor challenge hides cached account data and a new account gets separate rules', async () => {
  let raw = { requiresTwoFactorAuth: ['totp'] };
  const api = createApi({ fetchImpl: async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/friends')) {
      return response(parsed.searchParams.get('offline') === 'true' ? [] : [{ id: FRIEND, displayName: 'Other account friend' }]);
    }
    return response(raw);
  } });
  const h = harness({ api });
  const worker = h.worker();
  await worker.tick();
  const loggedOut = await worker.getState();
  assert.equal(loggedOut.connection.status, 'auth_required');
  assert.equal(loggedOut.account, null);
  assert.deepEqual(loggedOut.friends, []);
  assert.deepEqual(loggedOut.rules, {});

  raw = payload(OWNER_B, 'game');
  h.advance(31_000);
  await worker.tick({ manual: true });
  const loggedIn = await worker.getState();
  assert.equal(loggedIn.account.id, OWNER_B);
  assert.deepEqual(loggedIn.rules, {});
  assert.equal(h.disk.accounts[OWNER_A].rules[FRIEND].online, true);
  assert.deepEqual(h.notices, []);
});

test('a website account switch during roster pagination cannot commit mixed account data', async () => {
  const h = harness();
  h.setTime(T0 + ROSTER_INTERVAL);
  h.source.raw = payload(OWNER_A, 'game');
  h.source.roster = async () => {
    h.source.raw = payload(OWNER_B, 'game');
    return [{ id: FRIEND, name: 'Other account friend' }];
  };
  const worker = h.worker();
  await worker.tick();
  assert.equal(h.disk.activeAccountId, null);
  assert.equal(h.disk.accounts[OWNER_A].friends[0].name, 'Synthetic friend');
  assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'offline');
  assert.deepEqual(h.notices, []);

  h.advance(MINUTE);
  await worker.tick();
  assert.equal(h.disk.activeAccountId, OWNER_B);
  assert.deepEqual(h.disk.accounts[OWNER_B].rules, {});
  assert.deepEqual(h.notices, []);
});

test('simultaneous alarms and popup refresh share one synchronization and one notification', async () => {
  const h = harness();
  const started = deferred();
  const completion = deferred();
  h.source.current = async () => { started.resolve(); return completion.promise; };
  const worker = h.worker();
  const first = worker.tick();
  await started.promise;
  const second = worker.tick({ manual: true });
  const third = worker.tick();
  completion.resolve(readIdentity(payload(OWNER_A, 'game')));
  await Promise.all([first, second, third]);
  assert.equal(h.calls.current, 1);
  assert.equal(h.calls.roster, 0);
  assert.equal(h.notices.length, 1);
  assert.equal(h.disk.accounts[OWNER_A].events.length, 1);
});

test('pausing cancels a pending automatic commit, while a later manual snapshot stays paused and silent', async () => {
  const h = harness();
  const started = deferred();
  const completion = deferred();
  // Deliberately ignore the signal to reproduce a response already on its way
  // when the user pauses the monitor.
  h.source.current = async () => { started.resolve(); return completion.promise; };
  const worker = h.worker();
  const pending = worker.tick();
  await started.promise;
  await worker.updateSettings({ enabled: false });
  completion.resolve(readIdentity(payload(OWNER_A, 'game')));
  await pending;
  assert.equal(h.disk.connection.status, 'paused');
  assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'offline');
  assert.equal(h.disk.accounts[OWNER_A].lastSyncAt, T0);
  assert.deepEqual(h.notices, []);

  h.source.current = null;
  h.source.raw = payload(OWNER_A, 'game');
  h.advance(31_000);
  await worker.tick({ manual: true });
  assert.equal(h.disk.settings.enabled, false);
  assert.equal(h.disk.connection.status, 'paused');
  assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'game');
  assert.equal(h.disk.accounts[OWNER_A].lastSyncAt, h.now);
  assert.deepEqual(h.disk.accounts[OWNER_A].events, []);
  assert.deepEqual(h.notices, []);
  h.advance(MINUTE);
  await worker.tick();
  assert.equal(h.calls.current, 2, 'automatic work stays disabled after manual inspection');
});

test('documented legacy IDs are accepted without permitting prototype-shaped object keys', () => {
  const legacyId = 'DemoOld123';
  const raw = payload();
  raw.friends.push(legacyId, null);
  raw.activeFriends.push(legacyId, null);
  const identity = readIdentity(raw);
  assert.equal(identity.states.get(legacyId), 'web');
  assert.equal(identity.states.get(FRIEND), 'offline');
  for (const unsafe of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '', null]) {
    assert.equal(isUserId(unsafe), false);
  }
});
