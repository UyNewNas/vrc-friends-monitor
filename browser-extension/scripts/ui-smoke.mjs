import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { EXTENSION_ROOT, REPO_ROOT, RUNTIME_FILES } from "./project-files.mjs";

// Render actual UI files with a synthetic runtime. This does not load an installed
// extension, use a real browser profile, or contact the VRChat API.
const candidates = [process.env.VRC_MONITOR_CHROME, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
  .filter(Boolean);
const executable = candidates.find((candidate) => spawnSync(candidate, ["--version"], { timeout: 5000, stdio: "ignore" }).status === 0);
if (!executable) {
  console.error("Chrome/Chromium was not found. Set VRC_MONITOR_CHROME to a browser executable for the offline UI smoke test.");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "vrc-monitor-ui-"));
const outputRoot = join(REPO_ROOT, "artifacts", "preview");
mkdirSync(outputRoot, { recursive: true });
const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };
const server = createServer((request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1);
  if (!RUNTIME_FILES.includes(name)) { response.writeHead(404).end(); return; }
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(name)] || "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'",
  });
  response.end(readFileSync(join(EXTENSION_ROOT, name)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const child = spawn(executable, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions",
  "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let socket;
let nextId = 0;
const pending = new Map();
const runtimeErrors = [];
const unexpectedRequests = [];
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function send(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const accountId = "usr_00000000-0000-4000-8000-000000000001";
const friendIds = [2, 3, 4, 5].map((number) => `usr_00000000-0000-4000-8000-${String(number).padStart(12, "0")}`);
const unsafeName = '<img src=x onerror="globalThis.__injected=true">';
const fixtureTime = Date.now();
const fixture = {
  settings: { enabled: true, intervalMinutes: 1, notificationsEnabled: true },
  connection: {
    status: "connected", message: "演示数据 · 定时同步中", stale: false,
    lastSuccessAt: fixtureTime, nextAttemptAt: fixtureTime + 60000,
  },
  account: { id: accountId, name: "演示账号" },
  friends: [
    { id: friendIds[0], name: "演示好友 · 森", state: "game" },
    { id: friendIds[1], name: "演示好友 · 月", state: "web" },
    { id: friendIds[2], name: unsafeName, state: "offline" },
    { id: friendIds[3], name: "演示好友 · 云", state: "unknown" },
  ],
  rules: { [friendIds[0]]: { online: true, offline: false }, [friendIds[1]]: { online: false, offline: true } },
  events: [
    { id: "demo-event-1", friendId: friendIds[0], name: "演示好友 · 森", online: true, at: fixtureTime - 60000 },
    { id: "demo-event-2", friendId: friendIds[2], name: unsafeName, online: false, at: fixtureTime - 120000 },
  ],
  notificationWarning: null,
  notificationDelivery: { status: "idle", source: null, lastAttemptAt: null, lastAcceptedAt: null, permission: "unknown" },
};
const preload = `(() => {
  const state = ${JSON.stringify(fixture)};
  const messages = [];
  const listeners = [];
  globalThis.__smoke = {
    state, messages, notificationResult: 'accepted', holdNotification: false, releaseNotification: null,
    emit: () => listeners.forEach(listener => listener({}, 'local')),
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime: { sendMessage: async message => {
      messages.push(structuredClone(message));
      if (message.type === 'updateSettings') {
        Object.assign(state.settings, message.settings);
        state.connection.status = state.settings.enabled ? 'connected' : 'paused';
      } else if (message.type === 'setRule') {
        state.rules[message.friendId] = { online: message.online, offline: message.offline };
      } else if (message.type === 'clearHistory') {
        state.events = [];
      } else if (message.type === 'testNotification') {
        if (__smoke.holdNotification) await new Promise(resolve => { __smoke.releaseNotification = resolve; });
        __smoke.releaseNotification = null;
        const status = __smoke.notificationResult;
        const at = Date.now();
        state.notificationDelivery = {
          status, source: 'test', lastAttemptAt: at,
          lastAcceptedAt: status === 'accepted' ? at : state.notificationDelivery.lastAcceptedAt,
          permission: status === 'blocked' ? 'denied' : status === 'accepted' ? 'granted' : 'unknown',
        };
        state.notificationWarning = status === 'accepted' ? null : '浏览器通知不可用；状态与本地记录仍会更新。';
      } else if (!['getState', 'refresh', 'openLogin', 'openDashboard'].includes(message.type)) {
        throw new Error('Unexpected UI message');
      }
      return { ok: true, state: structuredClone(state) };
    } },
    storage: { onChanged: { addListener: listener => listeners.push(listener) } }
  } });
})();`;

async function evaluate(sessionId, expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error("UI smoke evaluation failed.");
  return result.result.value;
}

async function waitFor(sessionId, expression, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await evaluate(sessionId, expression)) return;
    await delay(50);
  }
  throw new Error(`UI did not reach expected state: ${label}`);
}

async function assertPage(sessionId, expression, label) {
  assert.equal(await evaluate(sessionId, expression), true, label);
}

async function page(name, width, height) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: preload }, sessionId);
  await send("Page.navigate", { url: `${origin}/${name}.html` }, sessionId);
  await waitFor(sessionId, "document.getElementById('accountName')?.textContent === '演示账号'", `${name} initial account`);
  return { sessionId, targetId };
}

async function screenshot(sessionId, name) {
  const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  writeFileSync(join(outputRoot, name), Buffer.from(result.data, "base64"));
}

try {
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not expose its local debugging endpoint.")), 15000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Chrome could not start.")); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Chrome exited before the smoke test started.")); });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome debugging connection timed out.")), 10000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chrome debugging connection failed.")); }, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`CDP command failed: ${message.error.message}`));
      else request.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      runtimeErrors.push(message.params.exceptionDetails.text);
    } else if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      if (new URL(request.url).origin === origin) {
        send("Fetch.continueRequest", { requestId }, message.sessionId).catch((error) => runtimeErrors.push(error.message));
      } else {
        unexpectedRequests.push("Non-fixture network request");
        send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, message.sessionId).catch((error) => runtimeErrors.push(error.message));
      }
    }
  });

  const dashboard = await page("dashboard", 1440, 1100);
  const sessionId = dashboard.sessionId;
  await assertPage(sessionId, "document.querySelectorAll('#friendsList .friend-row').length === 4", "Full roster rendered");
  await assertPage(sessionId, "['game','web','offline'].every(id => document.getElementById(id + 'Count').textContent === '1')", "Game/web/offline counters stay distinct");
  await assertPage(sessionId, "document.getElementById('notificationRuleHint').textContent.includes('已设置提醒 2 位好友') && document.getElementById('notificationStatus').textContent === '尚未尝试发送通知'", "Notification panel distinguishes configured friend rules from untested delivery");
  await assertPage(sessionId, `Array.from(document.querySelectorAll('.friend-name')).some(node => node.textContent === ${JSON.stringify(unsafeName)}) && !document.querySelector('#friendsList img') && !globalThis.__injected`, "Untrusted display names render only as text");
  await evaluate(sessionId, "__smoke.state.friends[2].name = '演示好友 · 曦'; __smoke.state.events[1].name = '演示好友 · 曦'; __smoke.emit();");
  await waitFor(sessionId, "Array.from(document.querySelectorAll('#friendsList .friend-name')).some(node => node.textContent === '演示好友 · 曦')", "Synthetic screenshot labels rendered");
  await screenshot(sessionId, "browser-extension-dashboard-synthetic.png");

  await evaluate(sessionId, "document.getElementById('friendsSearch').value = '森'; document.getElementById('friendsSearch').dispatchEvent(new Event('input'));");
  await assertPage(sessionId, "document.querySelectorAll('#friendsList .friend-row').length === 1 && document.querySelector('#friendsList .friend-name').textContent.includes('森')", "Name search filters roster");
  await evaluate(sessionId, "document.getElementById('friendsSearch').value = ''; document.getElementById('friendsSearch').dispatchEvent(new Event('input')); document.getElementById('friendState').value = 'web'; document.getElementById('friendState').dispatchEvent(new Event('change'));");
  await assertPage(sessionId, "document.querySelectorAll('#friendsList .friend-row').length === 1 && document.querySelector('#friendsList .state-web') !== null", "Website filter uses non-game state");
  await evaluate(sessionId, "document.getElementById('friendState').value = 'all'; document.getElementById('friendState').dispatchEvent(new Event('change')); document.getElementById('selectedOnly').click();");
  await assertPage(sessionId, "document.querySelectorAll('#friendsList .friend-row').length === 2", "Selected-only filter follows notification rules");
  await evaluate(sessionId, "document.getElementById('selectedOnly').click(); document.querySelector('input[data-action=\"set-rule\"][data-rule=\"offline\"]').click();");
  await waitFor(sessionId, "__smoke.messages.some(message => message.type === 'setRule') && !document.querySelector('input[data-action=\"set-rule\"]').disabled", "Rule persisted and controls re-enabled");
  const rule = await evaluate(sessionId, "__smoke.messages.find(message => message.type === 'setRule')");
  assert.deepEqual(rule, { type: "setRule", accountId, friendId: friendIds[0], online: true, offline: true }, "Notification mutation stays scoped to the account and friend");

  await evaluate(sessionId, "document.getElementById('intervalMinutes').value = '5'; document.getElementById('intervalMinutes').dispatchEvent(new Event('change'));");
  await waitFor(sessionId, "__smoke.state.settings.intervalMinutes === 5 && !document.getElementById('intervalMinutes').disabled", "Interval updated");
  await evaluate(sessionId, "document.getElementById('notificationsEnabled').click();");
  await waitFor(sessionId, "!__smoke.state.settings.notificationsEnabled && !document.getElementById('notificationsEnabled').disabled", "Global notification toggle updated");
  await evaluate(sessionId, "document.getElementById('toggleMonitoring').click();");
  await waitFor(sessionId, "!__smoke.state.settings.enabled && document.getElementById('toggleMonitoring').textContent === '开启监控'", "Pause rendered");
  await assertPage(sessionId, "document.getElementById('notificationRuleHint').textContent.includes('监控已暂停') && document.getElementById('notificationRuleHint').textContent.includes('桌面通知已关闭') && !document.getElementById('testNotification').disabled", "Disabled friend notifications are explained while testing stays available");
  await evaluate(sessionId, "__smoke.state.rules = {}; __smoke.state.notificationWarning = '浏览器通知不可用；状态与本地记录仍会更新。'; __smoke.emit();");
  await waitFor(sessionId, "document.getElementById('notificationRuleHint').textContent.includes('已设置提醒 0 位好友') && document.getElementById('notificationRuleHint').textContent.includes('勾选「上线」或「离线」')", "Zero rules explicitly require selecting friend transitions");
  await evaluate(sessionId, "__smoke.holdNotification = true; document.getElementById('testNotification').click(); document.getElementById('testNotification').click();");
  await assertPage(sessionId, "__smoke.messages.filter(message => message.type === 'testNotification').length === 1 && document.getElementById('testNotification').disabled && document.getElementById('testNotification').getAttribute('aria-busy') === 'true'", "Pending test notification prevents repeated clicks");
  await evaluate(sessionId, "__smoke.holdNotification = false; __smoke.releaseNotification();");
  await waitFor(sessionId, "document.getElementById('notificationStatus').textContent.startsWith('浏览器已接受测试通知') && !document.getElementById('testNotification').disabled", "Test submission result shown and test button restored");
  await assertPage(sessionId, "document.getElementById('notificationStatus').textContent.includes('最近尝试') && document.getElementById('notificationWarning').hidden && ['系统通知中心', '横幅', '勿扰'].every(text => document.getElementById('notificationHelp').textContent.includes(text))", "Accepted delivery clears old warnings and guides banner troubleshooting without claiming display");
  await assertPage(sessionId, "!__smoke.state.settings.enabled && !__smoke.state.settings.notificationsEnabled && Object.keys(__smoke.state.rules).length === 0 && __smoke.state.events.length === 2", "Test notification does not change monitoring, friend rules or history");
  assert.deepEqual(await evaluate(sessionId, "__smoke.messages.find(message => message.type === 'testNotification')"), { type: "testNotification" }, "Delivery test needs no account or friend data");
  await evaluate(sessionId, "document.getElementById('refreshButton').click();");
  await waitFor(sessionId, "__smoke.messages.some(message => message.type === 'refresh') && !document.getElementById('refreshButton').disabled", "Manual sync remains accessible while paused");
  await evaluate(sessionId, "document.getElementById('openLoginButton').click();");
  await waitFor(sessionId, "__smoke.messages.some(message => message.type === 'openLogin')", "Login button routes through background");

  await evaluate(sessionId, "document.getElementById('historySearch').value = '离线'; document.getElementById('historySearch').dispatchEvent(new Event('input'));");
  await assertPage(sessionId, "document.querySelectorAll('#historyList .history-row').length === 1", "History search accepts transition type");
  await evaluate(sessionId, "document.getElementById('clearHistoryButton').click();");
  await assertPage(sessionId, "document.getElementById('clearHistoryDialog').open && !__smoke.messages.some(message => message.type === 'clearHistory')", "History deletion requires confirmation in the UI");
  await evaluate(sessionId, "document.getElementById('confirmClearHistory').click();");
  await waitFor(sessionId, "__smoke.messages.some(message => message.type === 'clearHistory') && document.querySelectorAll('#historyList .history-row').length === 0", "Confirmed deletion clears history");
  assert.deepEqual(await evaluate(sessionId, "__smoke.messages.find(message => message.type === 'clearHistory')"), { type: "clearHistory", accountId });

  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 1100, deviceScaleFactor: 1, mobile: false }, sessionId);
  await assertPage(sessionId, "document.documentElement.scrollWidth <= innerWidth", "Narrow dashboard has no horizontal overflow");
  await screenshot(sessionId, "browser-extension-dashboard-narrow-synthetic.png");
  await evaluate(sessionId, `__smoke.state.events = ${JSON.stringify(fixture.events)}; __smoke.state.connection.status = 'auth_required'; __smoke.emit();`);
  await waitFor(sessionId, "document.getElementById('accountName').textContent === '未连接账号' && document.querySelectorAll('#friendsList .friend-row').length === 0", "Expired authentication hides retained account data");
  await assertPage(sessionId, "document.querySelectorAll('#historyList .history-row').length === 0 && document.getElementById('friendsSearch').value === '' && document.getElementById('historySearch').value === ''", "Expired authentication clears history and search context");
  await evaluate(sessionId, "__smoke.notificationResult = 'blocked'; document.getElementById('testNotification').click();");
  await waitFor(sessionId, "document.getElementById('notificationStatus').dataset.status === 'blocked' && !document.getElementById('testNotification').disabled", "Notification permission test works without a signed-in account");
  await assertPage(sessionId, "!document.getElementById('notificationWarning').hidden && document.getElementById('notificationStatus').textContent.includes('权限未开启') && document.getElementById('notificationRuleHint').textContent.includes('测试通知无需登录')", "Delivery failure remains visible after account data is hidden");
  await evaluate(sessionId, "__smoke.notificationResult = 'failed'; document.getElementById('testNotification').click();");
  await waitFor(sessionId, "document.getElementById('notificationStatus').dataset.status === 'failed' && !document.getElementById('testNotification').disabled", "Generic submission failure is distinct from denied permission");

  const popup = await page("popup", 390, 740);
  await assertPage(popup.sessionId, "document.querySelectorAll('#friendsList .friend-row').length === 2 && document.getElementById('selectedCount').textContent === '2'", "Popup shows followed friends");
  await assertPage(popup.sessionId, "document.documentElement.scrollWidth <= innerWidth", "Popup fits its extension width");
  await screenshot(popup.sessionId, "browser-extension-popup-synthetic.png");
  await evaluate(popup.sessionId, "document.getElementById('openDashboardButton').click();");
  await waitFor(popup.sessionId, "__smoke.messages.some(message => message.type === 'openDashboard')", "Popup opens full dashboard");
  await evaluate(popup.sessionId, "__smoke.state.connection.status = 'auth_required'; __smoke.emit();");
  await waitFor(popup.sessionId, "document.getElementById('accountName').textContent === '未连接账号' && document.querySelectorAll('#friendsList .friend-row').length === 0", "Popup also hides expired-session data");
  await evaluate(popup.sessionId, "document.getElementById('testNotification').click();");
  await waitFor(popup.sessionId, "__smoke.messages.some(message => message.type === 'testNotification') && document.getElementById('notificationStatus').textContent.startsWith('浏览器已接受测试通知') && !document.getElementById('testNotification').disabled", "Popup can test delivery without account synchronization");
  await assertPage(popup.sessionId, "document.documentElement.scrollWidth <= innerWidth && document.querySelectorAll('#friendsList .friend-row').length === 0", "Notification result keeps the popup narrow and account data hidden");

  assert.deepEqual(runtimeErrors, [], "No uncaught browser errors");
  assert.deepEqual(unexpectedRequests, [], "UI never contacted a non-fixture endpoint");
  console.log("Offline Chrome UI smoke passed: real popup/dashboard rendering, notification test controls and diagnostics, search, account-scoped rules, settings, confirmation, auth hiding and safe display names.");
  console.log("Synthetic previews: artifacts/preview/browser-extension-*-synthetic.png");
  console.log("Scope: mocked runtime only; real extension API coverage is in smoke:session, visible OS banners still require manual validation.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("UI smoke finished.")); }
  pending.clear();
  socket?.close();
  child.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await delay(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
