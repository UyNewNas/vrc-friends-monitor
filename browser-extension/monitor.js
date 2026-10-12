import {
  MINUTE, ROSTER_INTERVAL, MAX_EVENTS, MAX_ACCOUNTS,
  restoreState, normalizeSettings, makeSnapshot, changesBetween, retryDelay, publicState, isUserId,
} from './core.js';
import { ApiError } from './api.js';

const errorMessage = error => {
  if (error.status === 401) return '请在 VRChat 官网登录并完成验证，然后点击「立即同步」。';
  if (error.status === 403) return 'VRChat 暂时拒绝访问；请到官网检查登录或网页验证，稍后自动重试。';
  if (error.status === 429) return 'VRChat 请求限流；已暂停请求，等待后自动重试。';
  if (error.kind === 'account_changed') return '检测到官网账号切换，正在等待重新同步。';
  if (error.kind === 'format' || error.kind === 'pagination') return '好友数据尚不完整；已保留上次结果，稍后重新同步。';
  return '网络或 VRChat 服务暂不可用；已保留上次结果，稍后自动重试。';
};

export class Monitor {
  constructor({ api, load, save, schedule = async () => {}, notify = async () => {}, now = Date.now }) {
    Object.assign(this, { api, load, save, schedule, notify, now });
    this.queue = Promise.resolve();
    this.inFlight = null;
    this.generation = 0;
    this.abortController = null;
  }

  async ready() {
    if (!this.initializing) this.initializing = this.load().then(raw => { this.state = restoreState(raw); });
    await this.initializing;
  }

  async mutate(action) {
    await this.ready();
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async persist() {
    await this.save(structuredClone(this.state));
    await this.schedule(this.state.settings.enabled ? this.state.connection.nextAttemptAt : null);
  }

  async getState() {
    await this.ready();
    await this.queue;
    return publicState(this.state, this.now());
  }

  async recover({ startup = false } = {}) {
    await this.mutate(async () => {
      if (!this.state.settings.enabled) {
        this.state.connection.status = 'paused';
        this.state.connection.stale = true;
        this.state.connection.message = '监控已暂停。';
      } else if (startup || this.state.connection.status === 'syncing') {
        this.state.connection.stale = true;
        this.state.connection.status = this.state.connection.retryUntil > this.now() ? 'retrying' : 'idle';
        this.state.connection.nextAttemptAt = Math.max(this.now(), this.state.connection.retryUntil);
        this.state.connection.message = '正在恢复同步；恢复后的首次结果不会补发上下线通知。';
      }
      await this.persist();
    });
  }

  async tick({ manual = false, baseline = false } = {}) {
    await this.ready();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.sync({ manual, baseline }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async sync({ manual, baseline }) {
    const job = await this.mutate(async () => {
      const { connection, settings } = this.state;
      const now = this.now();
      if ((!settings.enabled && !manual) || now < connection.retryUntil) return null;
      if (manual && connection.lastAttemptAt !== null && now - connection.lastAttemptAt < 30_000) return null;
      if (!manual && connection.nextAttemptAt !== null && now < connection.nextAttemptAt) return null;
      const active = this.state.accounts[this.state.activeAccountId];
      const silent = baseline || manual || !settings.enabled || connection.stale || connection.status !== 'connected' ||
        !active?.lastSyncAt || now - active.lastSyncAt > settings.intervalMinutes * MINUTE * 2 + 15_000;
      connection.status = 'syncing';
      connection.message = '正在同步好友状态…';
      connection.lastAttemptAt = now;
      this.abortController = new AbortController();
      const operation = {
        generation: this.generation, silent,
        signal: AbortSignal.any([this.abortController.signal, AbortSignal.timeout(3 * MINUTE)]),
      };
      await this.persist();
      return operation;
    });
    if (!job) return this.getState();

    try {
      let identity = await this.api.currentUser(job.signal);
      const oldAccount = this.state.accounts[identity.id];
      const refreshRoster = !oldAccount || this.now() - oldAccount.rosterSyncedAt >= ROSTER_INTERVAL;
      const roster = refreshRoster ? await this.api.friends(job.signal) : [];
      if (refreshRoster) {
        const verified = await this.api.currentUser(job.signal);
        if (identity.id !== verified.id) throw new ApiError('account_changed');
        identity = verified;
      }
      await this.mutate(async () => {
        if (job.generation !== this.generation || (!this.state.settings.enabled && !manual)) return;
        const now = this.now();
        const switched = this.state.activeAccountId !== identity.id;
        const account = this.state.accounts[identity.id] ?? {
          id: identity.id, name: identity.name, friends: [], rules: {}, events: [], lastSyncAt: 0, rosterSyncedAt: 0,
        };
        const friends = makeSnapshot(identity, roster, account.friends);
        const changes = job.silent || switched ? [] : changesBetween(account.friends, friends, now);
        account.name = identity.name;
        account.friends = friends;
        account.lastSyncAt = now;
        if (refreshRoster) account.rosterSyncedAt = now;
        account.events = [...account.events, ...changes].slice(-MAX_EVENTS);
        this.state.accounts[identity.id] = account;
        this.state.activeAccountId = identity.id;
        // A bounded local cache; never persist the full auth/user API response.
        const oldest = Object.values(this.state.accounts).sort((a, b) => b.lastSyncAt - a.lastSyncAt);
        for (const stale of oldest.slice(MAX_ACCOUNTS)) delete this.state.accounts[stale.id];
        this.state.connection = {
          status: this.state.settings.enabled ? 'connected' : 'paused',
          message: this.state.settings.enabled ? '已连接 · 定时同步中' : '监控已暂停 · 手动同步已完成', stale: false,
          lastSuccessAt: now, lastAttemptAt: this.state.connection.lastAttemptAt,
          nextAttemptAt: this.state.settings.enabled ? now + this.state.settings.intervalMinutes * MINUTE : null,
          failures: 0, retryUntil: 0,
        };
        // Save the new baseline before notifications: a worker restart cannot
        // replay an already observed transition and flood desktop notifications.
        await this.persist();
        if (this.state.settings.notificationsEnabled) {
          for (const change of changes) {
            const rule = account.rules[change.friendId];
            if (!(change.online ? rule?.online : rule?.offline)) continue;
            try { await this.notify(change); }
            catch {
              this.state.notificationWarning = '浏览器通知不可用；状态与本地记录仍会更新。';
              await this.save(structuredClone(this.state));
              break;
            }
          }
        }
      });
    } catch (error) {
      await this.mutate(async () => {
        if (job.generation !== this.generation || error.kind === 'cancelled') return;
        const now = this.now();
        const failures = this.state.connection.failures + 1;
        const delay = retryDelay(error, failures);
        const authRequired = error.status === 401;
        if (authRequired || error.kind === 'account_changed') this.state.activeAccountId = null;
        this.state.connection = {
          ...this.state.connection,
          status: authRequired ? 'auth_required' : 'retrying', message: errorMessage(error), stale: true,
          nextAttemptAt: now + delay, failures,
          // User refresh and pause/resume cannot defeat server backoff.
          retryUntil: authRequired ? 0 : now + delay,
        };
        await this.persist();
      });
    }
    return this.getState();
  }

  async updateSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效。');
    for (const key of Object.keys(patch)) {
      if (!['enabled', 'intervalMinutes', 'notificationsEnabled'].includes(key)) throw new Error('未知设置。');
    }
    if (Object.hasOwn(patch, 'intervalMinutes') && ![1, 2, 5].includes(patch.intervalMinutes)) throw new Error('同步间隔只能是 1、2 或 5 分钟。');
    for (const key of ['enabled', 'notificationsEnabled']) {
      if (Object.hasOwn(patch, key) && typeof patch[key] !== 'boolean') throw new Error('设置格式无效。');
    }
    await this.mutate(async () => {
      const wasEnabled = this.state.settings.enabled;
      this.state.settings = normalizeSettings({ ...this.state.settings, ...patch });
      if (wasEnabled !== this.state.settings.enabled) {
        this.generation++;
        this.abortController?.abort();
        this.state.connection.stale = true;
        this.state.connection.status = this.state.settings.enabled ? 'idle' : 'paused';
        this.state.connection.message = this.state.settings.enabled ? '等待重新同步…' : '监控已暂停。';
        this.state.connection.nextAttemptAt = Math.max(this.now(), this.state.connection.retryUntil);
      } else if (patch.intervalMinutes) {
        this.state.connection.nextAttemptAt = Math.max(this.now() + patch.intervalMinutes * MINUTE, this.state.connection.retryUntil);
      }
      await this.persist();
    });
    return this.getState();
  }

  async setRule({ accountId, friendId, online, offline }) {
    await this.mutate(async () => {
      if (!isUserId(accountId) || accountId !== this.state.activeAccountId || !isUserId(friendId)) throw new Error('账号已变化，请刷新页面后重试。');
      const account = this.state.accounts[accountId];
      if (!account.friends.some(friend => friend.id === friendId)) throw new Error('好友已不在当前列表中，请刷新。');
      if (typeof online !== 'boolean' || typeof offline !== 'boolean') throw new Error('通知设置格式无效。');
      account.rules[friendId] = { online, offline };
      await this.persist();
    });
    return this.getState();
  }

  async clearHistory(accountId) {
    await this.mutate(async () => {
      if (!isUserId(accountId) || accountId !== this.state.activeAccountId) throw new Error('账号已变化，请刷新页面后重试。');
      this.state.accounts[accountId].events = [];
      await this.persist();
    });
    return this.getState();
  }
}
