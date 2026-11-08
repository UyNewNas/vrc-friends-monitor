// Pure state helpers. API payloads are reduced to the fields the monitor needs.
export const MINUTE = 60_000;
export const ROSTER_INTERVAL = 10 * MINUTE;
export const MAX_EVENTS = 1000;
export const MAX_ACCOUNTS = 3;
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  intervalMinutes: 1,
  notificationsEnabled: true,
});
export const NOTIFICATION_WARNINGS = Object.freeze({
  blocked: '浏览器已禁用本扩展通知；请检查浏览器和系统通知设置。',
  failed: '浏览器未能创建通知；状态与本地记录仍会更新，请发送测试通知重试。',
});

const ERROR_KINDS = new Set([
  'http', 'format', 'pagination', 'account_changed', 'timeout', 'network',
  'site_required', 'site_reload_required', 'site_unavailable', 'site_changed',
]);
const LEGACY_FORBIDDEN_MESSAGE = 'VRChat 暂时拒绝访问；请到官网检查登录或网页验证，稍后自动重试。';

// Keep only bounded diagnostic categories. Never persist a browser/network
// error message, response body, request URL, or authentication material.
export function errorDetails(error) {
  const errorKind = ERROR_KINDS.has(error?.kind) ? error.kind : 'network';
  const errorStatus = errorKind === 'http' && Number.isInteger(error?.status) &&
    error.status >= 400 && error.status <= 599 ? error.status : 0;
  return { errorKind, errorStatus };
}

export function isUserId(value) {
  return typeof value === 'string' && !Object.hasOwn(Object.prototype, value) &&
    (/^usr_[a-zA-Z0-9_-]{1,100}$/.test(value) || /^[a-zA-Z0-9]{10}$/.test(value));
}

export function cleanName(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.slice(0, 160) : fallback;
}

export function normalizeSettings(value = {}) {
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    intervalMinutes: [1, 2, 5].includes(value.intervalMinutes) ? value.intervalMinutes : 1,
    notificationsEnabled: typeof value.notificationsEnabled === 'boolean' ? value.notificationsEnabled : true,
  };
}

// Delivery diagnostics describe only the browser API result, never whether an
// operating-system banner was actually visible. Ignore arbitrary stored text.
export function normalizeNotificationDelivery(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const timestamp = value => Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : null;
  return {
    status: ['idle', 'accepted', 'blocked', 'failed'].includes(source.status) ? source.status : 'idle',
    source: ['test', 'friend'].includes(source.source) ? source.source : null,
    lastAttemptAt: timestamp(source.lastAttemptAt),
    lastAcceptedAt: timestamp(source.lastAcceptedAt),
    permission: ['unknown', 'granted', 'denied'].includes(source.permission) ? source.permission : 'unknown',
  };
}

export function emptyState() {
  return {
    schemaVersion: 1,
    settings: { ...DEFAULT_SETTINGS },
    activeAccountId: null,
    accounts: {},
    connection: {
      status: 'idle', message: '等待首次同步。', stale: true,
      lastSuccessAt: null, lastAttemptAt: null, nextAttemptAt: null,
      failures: 0, retryUntil: 0,
      errorKind: null, errorStatus: 0,
    },
    notificationWarning: null,
    notificationDelivery: normalizeNotificationDelivery(),
  };
}

export function restoreState(raw) {
  const state = emptyState();
  if (!raw || raw.schemaVersion !== 1) return state;
  state.settings = normalizeSettings(raw.settings);
  for (const [id, account] of Object.entries(raw.accounts ?? {}).slice(-MAX_ACCOUNTS)) {
    if (!isUserId(id) || !account || !Array.isArray(account.friends)) continue;
    const rules = {};
    for (const [friendId, rule] of Object.entries(account.rules ?? {})) {
      if (isUserId(friendId)) rules[friendId] = { online: rule?.online === true, offline: rule?.offline === true };
    }
    state.accounts[id] = {
      id, name: cleanName(account.name, id), rules,
      friends: account.friends.filter(f => f && isUserId(f.id)).map(f => ({
        id: f.id, name: cleanName(f.name, f.id),
        state: ['game', 'web', 'offline', 'unknown'].includes(f.state) ? f.state : 'unknown',
      })),
      events: Array.isArray(account.events) ? account.events.filter(e =>
        e && isUserId(e.friendId) && Number.isFinite(e.at) && typeof e.online === 'boolean'
      ).slice(-MAX_EVENTS).map(e => ({
        id: String(e.id).slice(0, 200), friendId: e.friendId,
        name: cleanName(e.name, e.friendId), online: e.online, at: e.at,
      })) : [],
      lastSyncAt: Number.isFinite(account.lastSyncAt) ? account.lastSyncAt : 0,
      rosterSyncedAt: Number.isFinite(account.rosterSyncedAt) ? account.rosterSyncedAt : 0,
    };
  }
  if (isUserId(raw.activeAccountId) && state.accounts[raw.activeAccountId]) {
    state.activeAccountId = raw.activeAccountId;
  }
  if (raw.connection && typeof raw.connection === 'object') {
    const source = raw.connection;
    if (['idle', 'syncing', 'connected', 'retrying', 'auth_required', 'paused'].includes(source.status)) {
      state.connection.status = source.status;
    }
    state.connection.message = cleanName(source.message, state.connection.message);
    state.connection.stale = source.stale !== false;
    for (const key of ['lastSuccessAt', 'lastAttemptAt', 'nextAttemptAt']) {
      state.connection[key] = Number.isFinite(source[key]) ? source[key] : null;
    }
    state.connection.failures = Math.max(0, Math.min(30, Number(source.failures) || 0));
    state.connection.retryUntil = Number.isFinite(source.retryUntil) ? source.retryUntil : 0;
    if (ERROR_KINDS.has(source.errorKind)) {
      Object.assign(state.connection, errorDetails({ kind: source.errorKind, status: source.errorStatus }));
    }
    // Version 0.1.0 treated an ordinary 403 as mandatory server backoff.
    // Migrate only its exact known state; preserve legacy 429/unknown waits.
    if (!Object.hasOwn(source, 'errorKind') && !Object.hasOwn(source, 'errorStatus') &&
        source.status === 'retrying' && source.message === LEGACY_FORBIDDEN_MESSAGE) {
      state.connection.retryUntil = 0;
      state.connection.errorKind = 'http';
      state.connection.errorStatus = 403;
      state.connection.message = '上次官网同步被拒绝；请保留官网标签页，刷新一次后点击「立即同步」。';
    }
  }
  state.notificationDelivery = normalizeNotificationDelivery(raw.notificationDelivery);
  if (['blocked', 'failed'].includes(state.notificationDelivery.status)) {
    state.notificationWarning = NOTIFICATION_WARNINGS[state.notificationDelivery.status];
  } else if (state.notificationDelivery.status !== 'accepted' && raw.notificationWarning) {
    state.notificationWarning = '浏览器通知不可用；状态与本地记录仍会更新。';
  }
  return state;
}

// These lists are also used by VRChat's own website. All fields must be present,
// but their membership can briefly disagree. Only friends controls membership;
// ambiguous presence stays unknown instead of implying a login or logout.
export function readIdentity(payload) {
  if (!payload || !isUserId(payload.id)) throw new Error('invalid_identity');
  const lists = ['friends', 'onlineFriends', 'activeFriends', 'offlineFriends'];
  const normalized = {};
  for (const key of lists) {
    if (!Array.isArray(payload[key])) throw new Error('incomplete_snapshot');
    const entries = payload[key].filter(id => id !== null);
    if (entries.some(id => !isUserId(id))) throw new Error('invalid_friend_id');
    normalized[key] = new Set(entries);
  }
  const presence = [['onlineFriends', 'game'], ['activeFriends', 'web'], ['offlineFriends', 'offline']];
  const states = new Map();
  for (const id of normalized.friends) {
    const matches = presence.filter(([key]) => normalized[key].has(id));
    states.set(id, matches.length === 1 ? matches[0][1] : 'unknown');
  }
  return { id: payload.id, name: cleanName(payload.displayName, payload.id), states };
}

export function makeSnapshot(identity, roster = [], previous = []) {
  const names = new Map(previous.map(f => [f.id, f.name]));
  for (const friend of roster) names.set(friend.id, cleanName(friend.name, friend.id));
  return [...identity.states].map(([id, state]) => ({ id, name: names.get(id) ?? id, state }));
}

export function changesBetween(previous, next, at) {
  const old = new Map(previous.map(friend => [friend.id, friend]));
  const changes = [];
  for (const friend of next) {
    const before = old.get(friend.id);
    // Newly added / removed friends are roster edits, not observed logins.
    if (!before || before.state === 'unknown' || friend.state === 'unknown') continue;
    if ((before.state === 'game') === (friend.state === 'game')) continue;
    const online = friend.state === 'game';
    changes.push({ id: `${at}:${friend.id}:${online ? 'on' : 'off'}`, friendId: friend.id, name: friend.name, online, at });
  }
  return changes;
}

export function retryDelay(error, failures) {
  if (error?.status === 401) return 15 * MINUTE;
  const exponential = Math.min(15 * MINUTE, MINUTE * 2 ** Math.min(Math.max(failures - 1, 0), 4));
  return Math.max(exponential, error?.status === 429 ? 2 * MINUTE : 0, error?.retryAfterMs || 0);
}

export function publicState(state, now = Date.now()) {
  const account = state.activeAccountId ? state.accounts[state.activeAccountId] : null;
  const stale = state.connection.stale || !account?.lastSyncAt ||
    now - account.lastSyncAt > state.settings.intervalMinutes * MINUTE * 2 + 15_000;
  return structuredClone({
    settings: state.settings,
    connection: { ...state.connection, stale },
    account: account && state.connection.status !== 'auth_required' ? { id: account.id, name: account.name } : null,
    friends: account && state.connection.status !== 'auth_required' ? account.friends : [],
    rules: account && state.connection.status !== 'auth_required' ? account.rules : {},
    events: account && state.connection.status !== 'auth_required' ? [...account.events].reverse() : [],
    notificationWarning: state.notificationWarning,
    notificationDelivery: normalizeNotificationDelivery(state.notificationDelivery),
  });
}
