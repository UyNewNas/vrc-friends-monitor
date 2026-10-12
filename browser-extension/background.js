import { createApi } from './api.js';
import { createWebsiteRequest } from './session.js';
import { Monitor } from './monitor.js';

export const STORAGE_KEY = 'vrcFriendsMonitorV1';
export const SYNC_ALARM = 'vrc-friends-sync';
export const WATCHDOG_ALARM = 'vrc-friends-watchdog';

export function createBackground(browser = chrome) {
  const monitor = new Monitor({
    api: createApi({ requestImpl: createWebsiteRequest(browser) }),
    load: async () => (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY],
    save: async state => {
      await browser.storage.local.set({ [STORAGE_KEY]: state });
      const connection = state.connection;
      const badge = !state.settings.enabled ? 'Ⅱ' : connection.status === 'auth_required' ? '!' : connection.stale ? '…' : '';
      await browser.action.setBadgeText({ text: badge });
      await browser.action.setBadgeBackgroundColor({ color: connection.stale ? '#b77b24' : '#286d5b' });
      await browser.action.setTitle({ title: `VRC Friends Monitor · ${connection.message}` });
    },
    schedule: async nextAttemptAt => {
      // Alarms can be cleared by browser updates/restarts. Recreate a missing
      // watchdog on every worker start, and keep the exact retry deadline too.
      const watchdog = await browser.alarms.get(WATCHDOG_ALARM);
      if (!watchdog) await browser.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
      if (nextAttemptAt === null) {
        await browser.alarms.clear(SYNC_ALARM);
        return;
      }
      const next = await browser.alarms.get(SYNC_ALARM);
      const when = Math.max(Date.now() + 1000, nextAttemptAt);
      if (!next || Math.abs(next.scheduledTime - when) > 1000) await browser.alarms.create(SYNC_ALARM, { when });
    },
    notify: async (change, { test = false } = {}) => {
      let permission = 'unknown';
      try {
        const level = await browser.notifications.getPermissionLevel();
        if (['granted', 'denied'].includes(level)) permission = level;
        if (permission !== 'granted') throw new Error('notifications_unavailable');
        const id = await browser.notifications.create(test ? 'vrc:notification-test' : `vrc:${change.id}`, {
          type: 'basic', iconUrl: browser.runtime.getURL('icons/icon128.png'),
          title: test ? 'VRC Friends Monitor · 测试通知' : change.online ? '好友进入 VRChat 游戏' : '好友离开 VRChat 游戏',
          message: test ? '如果你能看到这条消息，浏览器通知已到达。' : change.name,
          contextMessage: test ? '通知通道测试，不会改变好友记录' : '由好友状态同步检测到',
          silent: true,
        });
        // Chrome accepting a notification does not prove that the OS showed a
        // banner. Report only the API result, never infer desktop visibility.
        if (typeof id !== 'string' || !id) throw new Error('notification_not_created');
        return { permission };
      } catch {
        // Never forward native error text into state or the extension UI.
        throw Object.assign(new Error('notification_unavailable'), {
          kind: permission === 'denied' ? 'blocked' : 'failed', permission,
        });
      }
    },
  });

  // Only our own UI may issue commands. The website bridge answers requests
  // sent by this worker; it cannot read state or mutate settings/history.
  async function handleMessage(message, sender) {
    const ownOrigin = browser.runtime.getURL('');
    const allowedPages = ['popup.html', 'dashboard.html'].map(path => ownOrigin + path);
    if (sender.id !== browser.runtime.id || !sender.url || !allowedPages.includes(sender.url.split(/[?#]/)[0])) {
      return { ok: false, error: '消息来源无效。' };
    }
    try {
      if (!message || typeof message.type !== 'string') throw new Error('无效操作。');
      let state;
      switch (message.type) {
        case 'getState': state = await monitor.getState(); break;
        case 'refresh': state = await monitor.tick({ manual: true }); break;
        case 'testNotification': state = await monitor.testNotification(); break;
        case 'updateSettings': state = await monitor.updateSettings(message.settings); break;
        case 'setRule': state = await monitor.setRule(message); break;
        case 'clearHistory': state = await monitor.clearHistory(message.accountId); break;
        case 'openLogin':
          await browser.tabs.create({ url: 'https://vrchat.com/home/login' });
          return { ok: true };
        case 'openDashboard':
          await browser.runtime.openOptionsPage();
          return { ok: true };
        default: throw new Error('未知操作。');
      }
      return { ok: true, state };
    } catch (error) {
      // Do not forward raw network payloads, URLs, cookies, or browser errors.
      const safe = new Set(['设置格式无效。', '未知设置。', '同步间隔只能是 1、2 或 5 分钟。',
        '账号已变化，请刷新页面后重试。', '好友已不在当前列表中，请刷新。', '通知设置格式无效。', '无效操作。', '未知操作。']);
      return { ok: false, error: safe.has(error.message) ? error.message : '操作未完成，请稍后重试或重新加载扩展。' };
    }
  }

  const initialized = (async () => {
    await browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await monitor.recover();
  })();
  const safely = task => task.catch(() => {});
  // Register event listeners synchronously, before any initialization awaits.
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    initialized.then(() => handleMessage(message, sender)).then(sendResponse).catch(() => {
      sendResponse({ ok: false, error: '无法读取本地数据，请重新加载扩展。' });
    });
    return true;
  });
  browser.alarms.onAlarm.addListener(alarm => {
    if ([SYNC_ALARM, WATCHDOG_ALARM].includes(alarm.name)) safely(initialized.then(() => monitor.tick()));
  });
  browser.runtime.onInstalled.addListener(() => safely(initialized.then(() => monitor.tick({ baseline: true }))));
  browser.runtime.onStartup.addListener(() => safely(initialized.then(async () => {
    await monitor.recover({ startup: true });
    await monitor.tick({ baseline: true });
  })));
  safely(initialized);
  return { monitor, handleMessage, initialized };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) createBackground(chrome);
