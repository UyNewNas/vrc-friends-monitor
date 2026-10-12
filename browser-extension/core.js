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
    },
    notificationWarning: null,
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
  }
  if (raw.notificationWarning) state.notificationWarning = '浏览器通知不可用；状态与本地记录仍会更新。';
  return state;
}

// These lists are also used by VRChat's own website. Missing or contradictory
// lists are not a valid empty snapshot and must never generate logout events.
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
  const states = new Map();
  for (const [key, state] of [['onlineFriends', 'game'], ['activeFriends', 'web'], ['offlineFriends', 'offline']]) {
    for (const id of normalized[key]) {
      if (!normalized.friends.has(id)) throw new Error('inconsistent_membership');
      if (states.has(id)) throw new Error('conflicting_presence');
      states.set(id, state);
    }
  }
  for (const id of normalized.friends) {
    if (!states.has(id)) throw new Error('incomplete_presence');
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
  });
}
