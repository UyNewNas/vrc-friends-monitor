import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackground, STORAGE_KEY, SYNC_ALARM, WATCHDOG_ALARM } from '../background.js';

function event() {
  const listeners = [];
  return { listeners, addListener: listener => listeners.push(listener) };
}

function fixture(stored = undefined) {
  const data = stored ? { [STORAGE_KEY]: structuredClone(stored) } : {};
  const alarms = new Map();
  const opened = [];
  const notices = [];
  const trusted = [];
  const browser = {
    runtime: {
      id: 'synthetic-extension-id', getURL: path => `chrome-extension://synthetic-extension-id/${path}`,
      onMessage: event(), onInstalled: event(), onStartup: event(),
      openOptionsPage: async () => opened.push('dashboard'),
    },
    storage: { local: {
      get: async key => ({ [key]: structuredClone(data[key]) }),
      set: async value => Object.assign(data, structuredClone(value)),
      setAccessLevel: async value => trusted.push(value.accessLevel),
    } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    alarms: {
      onAlarm: event(), get: async key => alarms.get(key),
      create: async (name, options) => alarms.set(name, { name, ...options, scheduledTime: options.when }),
      clear: async name => alarms.delete(name),
    },
    tabs: { create: async options => opened.push(options.url) },
    notifications: {
      getPermissionLevel: async () => 'granted',
      create: async (id, options) => { notices.push({ id, ...options }); return id; },
    },
  };
  const background = createBackground(browser);
  let now = 1_800_000_000_000;
  background.monitor.now = () => now;
  background.monitor.api = {
    currentUser: async () => ({ id: 'usr_demo_account', name: '模拟账号', states: new Map([['usr_demo_friend', 'offline']]) }),
    friends: async () => [{ id: 'usr_demo_friend', name: '模拟好友' }],
  };
  const sender = { id: browser.runtime.id, url: browser.runtime.getURL('dashboard.html') };
  return { browser, background, data, alarms, opened, notices, trusted, sender, advance: ms => { now += ms; } };
}

test('worker registers all wake/message listeners synchronously and recreates missing watchdog', async () => {
  const f = fixture();
  assert.equal(f.browser.runtime.onMessage.listeners.length, 1);
  assert.equal(f.browser.runtime.onInstalled.listeners.length, 1);
  assert.equal(f.browser.runtime.onStartup.listeners.length, 1);
  assert.equal(f.browser.alarms.onAlarm.listeners.length, 1);
  await f.background.initialized;
  assert.deepEqual(f.trusted, ['TRUSTED_CONTEXTS']);
  assert.equal(f.alarms.get(WATCHDOG_ALARM).periodInMinutes, 1);
  await f.background.monitor.tick();
  assert.ok(f.alarms.get(SYNC_ALARM).scheduledTime > 0);
  const resumed = fixture(f.data[STORAGE_KEY]);
  await resumed.background.initialized;
  assert.ok(resumed.alarms.has(WATCHDOG_ALARM));
  assert.ok(resumed.alarms.has(SYNC_ALARM));
});

test('web pages and forged extension page URLs cannot issue commands', async () => {
  const f = fixture(); await f.background.initialized;
  for (const sender of [
    { id: 'other-extension', url: f.sender.url },
    { id: f.sender.id, url: 'https://vrchat.com/home' },
    { id: f.sender.id, url: f.sender.url + '.invalid' },
    { id: f.sender.id },
  ]) {
    assert.equal((await f.background.handleMessage({ type: 'openLogin' }, sender)).ok, false);
  }
  assert.deepEqual(f.opened, []);
});

test('the website content script cannot read cached state or change settings and history', async () => {
  const f = fixture(); await f.background.initialized;
  await f.background.monitor.tick();
  const before = structuredClone(f.data[STORAGE_KEY]);
  const sender = {
    id: f.browser.runtime.id, url: 'https://vrchat.com/home',
    tab: { id: 101, url: 'https://vrchat.com/home' }, frameId: 0,
  };
  for (const message of [
    { type: 'getState' },
    { type: 'refresh' },
    { type: 'testNotification' },
    { type: 'updateSettings', settings: { enabled: false } },
    { type: 'setRule', accountId: 'usr_demo_account', friendId: 'usr_demo_friend', online: true, offline: true },
    { type: 'clearHistory', accountId: 'usr_demo_account' },
    { type: 'openLogin' },
  ]) {
    assert.deepEqual(await f.background.handleMessage(message, sender), { ok: false, error: '消息来源无效。' });
  }
  assert.deepEqual(f.data[STORAGE_KEY], before);
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.notices, []);
});

test('login/dashboard commands open only built-in destinations and never accept arbitrary URLs', async () => {
  const f = fixture(); await f.background.initialized;
  assert.equal((await f.background.handleMessage({ type: 'openLogin', url: 'https://example.invalid' }, f.sender)).ok, true);
  await f.background.handleMessage({ type: 'openDashboard' }, f.sender);
  assert.deepEqual(f.opened, ['https://vrchat.com/home/login', 'dashboard']);
  assert.equal((await f.background.handleMessage({ type: 'fetch', url: 'https://example.invalid' }, f.sender)).ok, false);
});

test('persisted API snapshot excludes credentials and UI mutations require the observed account', async () => {
  const f = fixture(); await f.background.initialized;
  const result = await f.background.handleMessage({ type: 'refresh' }, f.sender);
  assert.equal(result.ok, true);
  assert.equal(result.state.account.id, 'usr_demo_account');
  assert.deepEqual(f.data[STORAGE_KEY].accounts.usr_demo_account.friends, [
    { id: 'usr_demo_friend', name: '模拟好友', state: 'offline' },
  ]);
  const stale = await f.background.handleMessage({ type: 'setRule', accountId: 'usr_other_account', friendId: 'usr_demo_friend', online: true, offline: false }, f.sender);
  assert.equal(stale.ok, false);
  assert.equal(Object.keys(f.data[STORAGE_KEY].accounts.usr_demo_account.rules).length, 0);
});

test('disabled automatic monitor clears sync alarm but permits one explicit silent snapshot', async () => {
  const f = fixture(); await f.background.initialized;
  await f.background.monitor.tick();
  await f.background.handleMessage({ type: 'updateSettings', settings: { enabled: false } }, f.sender);
  assert.equal(f.alarms.has(SYNC_ALARM), false);
  f.advance(60_000);
  f.background.monitor.api.currentUser = async () => ({ id: 'usr_demo_account', name: '模拟账号', states: new Map([['usr_demo_friend', 'game']]) });
  const auto = await f.background.monitor.tick();
  assert.equal(auto.friends[0].state, 'offline');
  const manual = await f.background.handleMessage({ type: 'refresh' }, f.sender);
  assert.equal(manual.state.friends[0].state, 'game');
  assert.equal(manual.state.settings.enabled, false);
  assert.equal(manual.state.connection.status, 'paused');
  assert.equal(manual.state.connection.nextAttemptAt, null);
  assert.equal(f.alarms.has(SYNC_ALARM), false);
  assert.deepEqual(f.notices, []);
  assert.deepEqual(manual.state.events, []);
});

test('own popup can test notifications without an account, monitoring or friend rules', async () => {
  const f = fixture(); await f.background.initialized;
  await f.background.handleMessage({ type: 'updateSettings', settings: { enabled: false, notificationsEnabled: false } }, f.sender);
  f.background.monitor.api.currentUser = async () => { assert.fail('a notification test must not query VRChat'); };
  const before = structuredClone(f.data[STORAGE_KEY]);
  const alarmsBefore = structuredClone([...f.alarms]);
  const sender = { ...f.sender, url: f.browser.runtime.getURL('popup.html') };
  const result = await f.background.handleMessage({ type: 'testNotification', message: 'ignored injected text' }, sender);
  assert.equal(result.ok, true);
  assert.equal(result.state.account, null);
  assert.deepEqual(result.state.events, []);
  assert.deepEqual(result.state.settings, before.settings);
  assert.deepEqual(f.data[STORAGE_KEY].connection, before.connection);
  assert.deepEqual([...f.alarms], alarmsBefore);
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].id, 'vrc:notification-test');
  assert.equal(f.notices[0].type, 'basic');
  assert.equal(f.notices[0].iconUrl, f.browser.runtime.getURL('icons/icon128.png'));
  assert.ok(!JSON.stringify(f.notices).includes('ignored injected text'));
  assert.deepEqual(result.state.notificationDelivery, {
    status: 'accepted', source: 'test', permission: 'granted',
    lastAttemptAt: 1_800_000_000_000, lastAcceptedAt: 1_800_000_000_000,
  });
  assert.deepEqual(f.data[STORAGE_KEY].notificationDelivery, result.state.notificationDelivery);
});

test('denied notification permission is actionable and a later accepted test clears its warning', async () => {
  const f = fixture(); await f.background.initialized;
  f.browser.notifications.getPermissionLevel = async () => 'denied';
  const denied = await f.background.handleMessage({ type: 'testNotification' }, f.sender);
  assert.equal(denied.ok, true);
  assert.equal(denied.state.notificationDelivery.status, 'blocked');
  assert.equal(denied.state.notificationDelivery.permission, 'denied');
  assert.equal(denied.state.notificationDelivery.lastAcceptedAt, null);
  assert.ok(denied.state.notificationWarning);
  assert.deepEqual(f.notices, []);
  f.advance(1000);
  f.browser.notifications.getPermissionLevel = async () => 'granted';
  const accepted = await f.background.handleMessage({ type: 'testNotification' }, f.sender);
  assert.equal(accepted.state.notificationDelivery.status, 'accepted');
  assert.equal(accepted.state.notificationDelivery.lastAcceptedAt, 1_800_000_001_000);
  assert.equal(accepted.state.notificationWarning, null);
  assert.equal(f.data[STORAGE_KEY].notificationWarning, null);
});

test('notification API failures and empty IDs never claim acceptance or leak native errors', async () => {
  for (const scenario of ['permission-error', 'unknown-permission', 'create-error', 'empty-id']) {
    const f = fixture(); await f.background.initialized;
    const privateError = 'synthetic native error payload must not persist';
    if (scenario === 'permission-error') f.browser.notifications.getPermissionLevel = async () => { throw new Error(privateError); };
    if (scenario === 'unknown-permission') f.browser.notifications.getPermissionLevel = async () => 'unexpected';
    if (scenario === 'create-error') f.browser.notifications.create = async () => { throw new Error(privateError); };
    if (scenario === 'empty-id') f.browser.notifications.create = async () => '';
    const result = await f.background.handleMessage({ type: 'testNotification' }, f.sender);
    assert.equal(result.ok, true, scenario);
    assert.equal(result.state.notificationDelivery.status, 'failed', scenario);
    assert.equal(result.state.notificationDelivery.permission,
      ['permission-error', 'unknown-permission'].includes(scenario) ? 'unknown' : 'granted', scenario);
    assert.equal(result.state.notificationDelivery.lastAcceptedAt, null, scenario);
    assert.ok(result.state.notificationWarning, scenario);
    assert.ok(!JSON.stringify({ result, data: f.data }).includes(privateError), scenario);
  }
});

test('normal manual sync submits a selected friend notification after saving the new baseline', async () => {
  const f = fixture(); await f.background.initialized;
  await f.background.monitor.tick();
  await f.background.handleMessage({ type: 'setRule', accountId: 'usr_demo_account', friendId: 'usr_demo_friend', online: true, offline: false }, f.sender);
  f.advance(60_000);
  f.background.monitor.api.currentUser = async () => ({ id: 'usr_demo_account', name: '模拟账号', states: new Map([['usr_demo_friend', 'game']]) });
  const create = f.browser.notifications.create;
  f.browser.notifications.create = async (id, options) => {
    const account = f.data[STORAGE_KEY].accounts.usr_demo_account;
    assert.equal(account.friends[0].state, 'game');
    assert.equal(account.events.length, 1);
    assert.equal(id, `vrc:${account.events[0].id}`);
    return create(id, options);
  };
  const result = await f.background.handleMessage({ type: 'refresh' }, f.sender);
  assert.equal(result.state.events.length, 1);
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].title, '好友进入 VRChat 游戏');
  assert.equal(f.notices[0].message, '模拟好友');
  assert.equal(result.state.notificationDelivery.source, 'friend');
  assert.equal(result.state.notificationDelivery.status, 'accepted');
  assert.equal(result.state.notificationDelivery.permission, 'granted');
  f.advance(60_000);
  await f.background.monitor.tick();
  assert.equal(f.notices.length, 1);
});
