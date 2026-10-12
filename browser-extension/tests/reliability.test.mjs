import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi } from '../api.js';
import { MINUTE, ROSTER_INTERVAL, emptyState, isUserId, readIdentity, restoreState, publicState } from '../core.js';
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

test('a fresh manual refresh records and notifies a transition before the next alarm without consuming it silently', async () => {
  const h = harness();
  h.setTime(T0 + 31_000);
  h.source.raw = payload(OWNER_A, 'game');
  const worker = h.worker();
  const state = await worker.tick({ manual: true });
  assert.equal(state.friends[0].state, 'game');
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].online, true);
  assert.equal(h.notices.length, 1);
  assert.equal(state.notificationDelivery.status, 'accepted');
  assert.equal(state.notificationDelivery.source, 'friend');

  h.advance(MINUTE);
  await worker.tick();
  assert.equal(h.calls.current, 2);
  assert.equal(h.disk.accounts[OWNER_A].events.length, 1);
  assert.equal(h.notices.length, 1, 'the following alarm does not repeat the observed transition');
});

test('manual refresh still requires both the global switch and the matching friend rule to notify', async () => {
  for (const suppressWith of ['global', 'rule']) {
    const saved = connectedState();
    if (suppressWith === 'global') saved.settings.notificationsEnabled = false;
    else saved.accounts[OWNER_A].rules[FRIEND].online = false;
    const h = harness({ saved });
    h.source.raw = payload(OWNER_A, 'game');
    const result = await h.worker().tick({ manual: true });
    assert.equal(result.events.length, 1);
    assert.deepEqual(h.notices, []);
    assert.equal(result.notificationDelivery.status, 'idle');
  }
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

for (const [kind, status] of [
  ['http', 403], ['network', 0], ['site_unavailable', 0], ['site_changed', 0],
]) {
  test(`${kind}${status ? ` ${status}` : ''} recovery permits a throttled manual retry before the automatic deadline`, async () => {
    const h = harness({ saved: connectedState('game') });
    h.source.current = async () => { throw new ApiError(kind, status); };
    const worker = h.worker();
    await worker.tick();
    assert.equal(h.disk.connection.retryUntil, 0);
    assert.equal(h.disk.connection.nextAttemptAt, h.now + MINUTE);
    assert.equal(h.disk.connection.errorKind, kind);
    assert.equal(h.disk.connection.errorStatus, status);
    assert.equal((await worker.getState()).connection.stale, true);
    assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'game');

    h.source.current = null;
    h.source.raw = payload(OWNER_A, 'offline');
    h.advance(29_999);
    await worker.tick({ manual: true });
    assert.equal(h.calls.current, 1, 'ordinary failures still have a 30-second manual request throttle');
    h.advance(1_001);
    await worker.tick();
    assert.equal(h.calls.current, 1, 'automatic work still respects exponential backoff');
    await worker.tick({ manual: true });
    assert.equal(h.calls.current, 2);
    assert.equal(h.disk.connection.status, 'connected');
    assert.equal(h.disk.connection.errorKind, null);
    assert.equal(h.disk.connection.errorStatus, 0);
    assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'offline');
    assert.deepEqual(h.disk.accounts[OWNER_A].events, []);
    assert.deepEqual(h.notices, []);
  });
}

for (const kind of ['site_required', 'site_reload_required']) {
  test(`${kind} preserves the account and allows immediate manual recovery once the website is ready`, async () => {
    const h = harness({ saved: connectedState('game') });
    h.source.current = async () => { throw new ApiError(kind); };
    let worker = h.worker();
    await worker.tick();
    const unavailable = await worker.getState();
    assert.equal(unavailable.account.id, OWNER_A);
    assert.equal(unavailable.friends[0].state, 'game');
    assert.equal(unavailable.connection.stale, true);
    assert.equal(unavailable.connection.errorKind, kind);
    assert.equal(unavailable.connection.retryUntil, 0);
    assert.match(unavailable.connection.message, /保留/);
    if (kind === 'site_reload_required') assert.match(unavailable.connection.message, /刷新.*一次/);
    for (let attempt = 0; attempt < 3; attempt++) {
      h.advance(MINUTE);
      await worker.tick();
      assert.equal(h.disk.connection.nextAttemptAt, h.now + MINUTE,
        'checking local website readiness stays at one minute even after repeated misses');
    }
    const attempts = h.calls.current;

    h.source.current = null;
    h.source.raw = payload(OWNER_A, 'offline');
    h.advance(1_000);
    worker = h.worker();
    await worker.recover();
    await worker.tick();
    assert.equal(h.calls.current, attempts, 'opening the popup does not repeatedly retry an unavailable website');
    await worker.tick({ manual: true });
    assert.equal(h.calls.current, attempts + 1, 'a previously missing page or bridge issued no API request and needs no delay');
    assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'offline');
    assert.deepEqual(h.disk.accounts[OWNER_A].events, []);
    assert.deepEqual(h.notices, []);
  });
}

for (const status of [403, 503]) {
  test(`HTTP ${status} with Retry-After remains a hard server deadline`, async () => {
    const h = harness();
    h.source.current = async () => { throw new ApiError('http', status, 7 * MINUTE); };
    let worker = h.worker();
    await worker.tick();
    const deadline = h.now + 7 * MINUTE;
    assert.equal(h.disk.connection.retryUntil, deadline);
    h.source.current = null;
    h.source.raw = payload(OWNER_A, 'game');
    h.advance(31_000);
    await worker.tick({ manual: true });
    await worker.updateSettings({ enabled: false });
    await worker.updateSettings({ enabled: true });
    worker = h.worker();
    await worker.recover({ startup: true });
    h.setTime(deadline - 1);
    await worker.tick({ manual: true });
    assert.equal(h.calls.current, 1);
    h.setTime(deadline);
    await worker.tick({ manual: true });
    assert.equal(h.calls.current, 2);
    assert.equal(h.disk.connection.retryUntil, 0);
    assert.deepEqual(h.notices, []);
  });
}

test('website readiness cannot defeat a persisted mandatory server wait', async () => {
  const saved = connectedState();
  saved.connection.status = 'retrying';
  saved.connection.errorKind = 'site_reload_required';
  saved.connection.retryUntil = T0 + 7 * MINUTE;
  const h = harness({ saved });
  const worker = h.worker();
  await worker.recover();
  await worker.tick({ manual: true });
  assert.equal(h.calls.current, 0, 'hard deadlines are checked before the immediate website recovery exception');
});

test('upgrade removes only the exact version 0.1.0 ordinary 403 cooldown', async () => {
  const saved = connectedState('game');
  const legacyMessage = 'VRChat 暂时拒绝访问；请到官网检查登录或网页验证，稍后自动重试。';
  saved.connection = {
    ...saved.connection, status: 'retrying', message: legacyMessage, stale: true,
    retryUntil: T0 + 15 * MINUTE, nextAttemptAt: T0 + 15 * MINUTE,
  };
  const h = harness({ saved });
  const worker = h.worker();
  await worker.recover();
  const restored = await worker.getState();
  assert.equal(restored.connection.retryUntil, 0);
  assert.equal(restored.connection.errorKind, 'http');
  assert.equal(restored.connection.errorStatus, 403);
  await worker.tick();
  assert.equal(h.calls.current, 0, 'the stored automatic schedule is preserved');
  await worker.tick({ manual: true });
  assert.equal(h.calls.current, 1);
  assert.equal(h.disk.connection.status, 'connected');
  assert.deepEqual(h.notices, []);

  for (const message of [
    'VRChat 请求限流；已暂停请求，等待后自动重试。',
    'Unknown legacy failure',
    legacyMessage + ' ',
  ]) {
    const legacy = structuredClone(saved);
    legacy.connection.message = message;
    assert.equal(restoreState(legacy).connection.retryUntil, saved.connection.retryUntil);
  }
  const current = structuredClone(saved);
  current.connection.errorKind = 'http';
  current.connection.errorStatus = 403;
  assert.equal(restoreState(current).connection.retryUntil, saved.connection.retryUntil,
    'a modern 403 with a real Retry-After must not undergo the legacy migration');
});

test('old version 0.1.0 rate limiting remains enforced after upgrade and browser restart', async () => {
  const saved = connectedState();
  saved.connection = {
    ...saved.connection, status: 'retrying', stale: true,
    message: 'VRChat 请求限流；已暂停请求，等待后自动重试。',
    retryUntil: T0 + 7 * MINUTE, nextAttemptAt: T0 + 7 * MINUTE,
  };
  const h = harness({ saved });
  const worker = h.worker();
  await worker.recover({ startup: true });
  await worker.tick({ manual: true });
  assert.equal(h.calls.current, 0);
  h.setTime(T0 + 7 * MINUTE);
  await worker.tick();
  assert.equal(h.calls.current, 1);
});

test('failure diagnostics persist only bounded categories and HTTP statuses', async () => {
  const h = harness();
  h.source.current = async () => {
    const error = new Error('synthetic private browser diagnostic');
    error.kind = 'synthetic private browser category';
    error.status = 'synthetic private status';
    throw error;
  };
  const worker = h.worker();
  await worker.tick();
  assert.equal(h.disk.connection.errorKind, 'network');
  assert.equal(h.disk.connection.errorStatus, 0);
  assert.equal(JSON.stringify(h.disk).includes('synthetic private'), false);

  const saved = h.disk;
  saved.connection.errorKind = 'http';
  saved.connection.errorStatus = 99999;
  assert.equal(restoreState(saved).connection.errorStatus, 0);
  saved.connection.errorKind = 'synthetic private category';
  saved.connection.errorStatus = 403;
  const restored = restoreState(saved);
  assert.equal(restored.connection.errorKind, null);
  assert.equal(restored.connection.errorStatus, 0);
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
  ['an invalid friend ID', raw => { raw.offlineFriends = ['invalid']; }],
]) {
  test(`API schema failure with ${name} preserves the last complete snapshot`, async () => {
    const raw = payload();
    mutate(raw);
    let requests = 0;
    const api = createApi({ requestImpl: async () => { requests++; return raw; } });
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

for (const [name, mutate] of [
  ['conflicting online/offline membership', raw => { raw.onlineFriends = [FRIEND]; }],
  ['a friend absent from every presence array', raw => { raw.offlineFriends = []; }],
]) {
  test(`ambiguous presence with ${name} becomes unknown without inventing a logout`, async () => {
    const raw = payload();
    mutate(raw);
    const api = createApi({ requestImpl: async () => raw });
    const h = harness({ api, saved: connectedState('game') });
    const worker = h.worker();
    await worker.tick();
    assert.equal(h.disk.connection.status, 'connected');
    assert.equal(h.disk.accounts[OWNER_A].friends[0].state, 'unknown');
    assert.deepEqual(h.disk.accounts[OWNER_A].events, []);
    assert.deepEqual(h.notices, []);
  });
}

test('an HTTP 200 two-factor challenge hides cached account data and a new account gets separate rules', async () => {
  let raw = { requiresTwoFactorAuth: ['totp'] };
  const api = createApi({ requestImpl: async path => {
    const parsed = new URL(path, 'https://synthetic.invalid/');
    if (parsed.pathname.endsWith('/friends')) {
      return parsed.searchParams.get('offline') === 'true' ? [] : [{ id: FRIEND, displayName: 'Other account friend' }];
    }
    return raw;
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

for (const manualFirst of [false, true]) {
  test(`simultaneous alarms and popup refresh share one synchronization and notification when ${manualFirst ? 'manual refresh' : 'the alarm'} starts first`, async () => {
    const h = harness();
    const started = deferred();
    const completion = deferred();
    h.source.current = async () => { started.resolve(); return completion.promise; };
    const worker = h.worker();
    const first = worker.tick({ manual: manualFirst });
    await started.promise;
    const second = worker.tick({ manual: !manualFirst });
    const third = worker.tick();
    completion.resolve(readIdentity(payload(OWNER_A, 'game')));
    await Promise.all([first, second, third]);
    assert.equal(h.calls.current, 1);
    assert.equal(h.calls.roster, 0);
    assert.equal(h.notices.length, 1);
    assert.equal(h.disk.accounts[OWNER_A].events.length, 1);
  });
}

test('an explicit notification test works while logged out, paused, or globally disabled without changing monitoring', async () => {
  const paused = connectedState();
  paused.settings.enabled = false;
  paused.connection.status = 'paused';
  paused.connection.nextAttemptAt = null;
  const disabled = connectedState();
  disabled.settings.notificationsEnabled = false;
  const loggedOut = connectedState();
  loggedOut.activeAccountId = null;
  loggedOut.connection.status = 'auth_required';
  for (const saved of [emptyState(), loggedOut, paused, disabled]) {
    const h = harness({ saved });
    const worker = h.worker();
    await worker.ready();
    const before = structuredClone(worker.state);
    const sends = [];
    worker.notify = async (change, options) => { sends.push({ change, options }); return { permission: 'granted' }; };
    const result = await worker.testNotification();
    assert.deepEqual(sends, [{ change: null, options: { test: true } }]);
    assert.deepEqual(h.calls, { current: 0, roster: 0 });
    assert.deepEqual(h.deadlines, [], 'testing a notification does not reschedule synchronization');
    assert.deepEqual(h.disk.settings, before.settings);
    assert.deepEqual(h.disk.accounts, before.accounts);
    assert.deepEqual(h.disk.connection, before.connection);
    assert.deepEqual(result.notificationDelivery, {
      status: 'accepted', source: 'test', lastAttemptAt: h.now, lastAcceptedAt: h.now, permission: 'granted',
    });
    assert.equal(result.notificationWarning, null);
  }
});

test('notification diagnostics persist safe failures, recover after permission is granted, and retain the last acceptance time', async () => {
  const h = harness();
  const worker = h.worker();
  worker.notify = async () => { throw Object.assign(new Error('Synthetic private diagnostic text'), { kind: 'blocked', permission: 'denied' }); };
  let result = await worker.testNotification();
  assert.deepEqual(result.notificationDelivery, {
    status: 'blocked', source: 'test', lastAttemptAt: h.now, lastAcceptedAt: null, permission: 'denied',
  });
  assert.ok(result.notificationWarning.includes('禁用'));
  assert.equal(JSON.stringify(h.disk).includes('Synthetic private diagnostic text'), false);

  h.advance(5000);
  worker.notify = async () => ({ permission: 'granted' });
  result = await worker.testNotification();
  const acceptedAt = h.now;
  assert.equal(result.notificationDelivery.status, 'accepted');
  assert.equal(result.notificationDelivery.lastAcceptedAt, acceptedAt);
  assert.equal(result.notificationWarning, null);

  h.advance(5000);
  worker.notify = async () => { throw Object.assign(new Error('Synthetic browser failure text'), { kind: 'unrecognized', permission: 'untrusted' }); };
  result = await worker.testNotification();
  assert.deepEqual(result.notificationDelivery, {
    status: 'failed', source: 'test', lastAttemptAt: h.now, lastAcceptedAt: acceptedAt, permission: 'unknown',
  });
  assert.ok(result.notificationWarning.includes('未能创建'));
  assert.equal(result.connection.status, 'connected', 'notification errors do not create a connection failure');
  assert.equal(JSON.stringify(h.disk).includes('Synthetic browser failure text'), false);
  assert.deepEqual(restoreState(h.disk).notificationDelivery, result.notificationDelivery);
  assert.deepEqual(h.calls, { current: 0, roster: 0 });
  assert.deepEqual(h.deadlines, []);
});

test('a rejected friend notification leaves the saved observations intact and is not replayed after worker recovery', async () => {
  const secondFriend = 'usr_synthetic_friend_two';
  const saved = connectedState();
  saved.accounts[OWNER_A].friends.push({ id: secondFriend, name: 'Synthetic friend two', state: 'offline' });
  saved.accounts[OWNER_A].rules[secondFriend] = { online: true, offline: true };
  const h = harness({ saved });
  h.source.raw = payload(OWNER_A, 'game');
  h.source.raw.friends.push(secondFriend);
  h.source.raw.onlineFriends.push(secondFriend);
  let attempts = 0;
  const worker = h.worker();
  worker.notify = async () => {
    attempts++;
    assert.equal(h.disk.accounts[OWNER_A].events.length, 2, 'both observations are saved before attempting notification');
    throw Object.assign(new Error('Synthetic denied notification'), { kind: 'blocked', permission: 'denied' });
  };
  const result = await worker.tick({ manual: true });
  assert.equal(attempts, 1, 'a delivery failure stops the rest of this notification batch');
  assert.equal(result.connection.status, 'connected');
  assert.equal(result.connection.failures, 0);
  assert.equal(result.notificationDelivery.source, 'friend');
  assert.equal(result.notificationDelivery.status, 'blocked');
  assert.equal(result.events.length, 2);

  h.advance(MINUTE);
  const resumed = h.worker();
  await resumed.recover();
  await resumed.tick();
  assert.equal(h.disk.accounts[OWNER_A].events.length, 2);
  assert.deepEqual(h.notices, [], 'a restart must not replay the previously rejected transition');
});

test('persisted notification diagnostics accept only known fields and finite valid timestamps', () => {
  const saved = connectedState();
  saved.notificationWarning = 'Synthetic raw error text';
  saved.notificationDelivery = {
    status: 'accepted', source: 'test', lastAttemptAt: T0, lastAcceptedAt: T0, permission: 'granted',
    rawError: 'Synthetic response text', arbitraryField: ['ignored'],
  };
  const restored = restoreState(saved);
  const visible = publicState(restored, T0 + MINUTE);
  assert.deepEqual(visible.notificationDelivery, {
    status: 'accepted', source: 'test', lastAttemptAt: T0, lastAcceptedAt: T0, permission: 'granted',
  });
  assert.equal(restored.notificationWarning, null, 'successful delivery clears a stale legacy warning on restore');
  assert.equal(JSON.stringify(restored).includes('Synthetic raw error text'), false);
  assert.equal(JSON.stringify(restored).includes('Synthetic response text'), false);

  for (const invalidTime of [NaN, Infinity, -1, '2026-10-12', 8.64e15 + 1]) {
    saved.notificationDelivery = {
      status: 'unexpected', source: 'unexpected', permission: 'unexpected',
      lastAttemptAt: invalidTime, lastAcceptedAt: invalidTime,
    };
    assert.deepEqual(restoreState(saved).notificationDelivery, emptyState().notificationDelivery);
  }
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
