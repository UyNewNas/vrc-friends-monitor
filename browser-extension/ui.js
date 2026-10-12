/* All account data comes from the extension background; these pages make no API requests. */
(() => {
  "use strict";

  const isPopup = document.body.dataset.page === "popup";
  const byId = (id) => document.getElementById(id);
  const stateLabels = { game: "游戏在线", web: "网页活跃", offline: "离线", unknown: "状态未知" };
  const stateOrder = { game: 0, web: 1, offline: 2, unknown: 3 };
  const statusLabels = {
    idle: "等待首次同步",
    syncing: "正在同步好友状态",
    connected: "监控已连接",
    retrying: "等待重新连接",
    auth_required: "需要登录 VRChat",
    paused: "监控已暂停",
  };
  const dateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const clockFormat = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });

  let state = null;
  let accountEpoch = 0;
  let readSequence = 0;
  let mutationSequence = 0;
  let settingsPending = false;
  let refreshPending = false;
  let historyPending = false;
  let clearHistoryAccountId = null;
  let historyLimit = 150;
  let friendsFingerprint = null;
  let historyFingerprint = null;
  let feedbackTimer;
  let reloadTimer;
  const pendingRules = new Set();

  function safeText(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
  }

  function accountFor(value = state) {
    if (!value || value.connection?.status === "auth_required") return null;
    return typeof value.account?.id === "string" && value.account.id ? value.account : null;
  }

  function currentFriends() {
    if (!accountFor() || !Array.isArray(state.friends)) return [];
    return state.friends.filter((friend) => friend && typeof friend.id === "string" && friend.id);
  }

  function currentEvents() {
    if (!accountFor() || !Array.isArray(state.events)) return [];
    return state.events.filter((event) => event && typeof event.friendId === "string" && typeof event.online === "boolean");
  }

  function ruleFor(friendId) {
    const rule = accountFor() ? state.rules?.[friendId] : null;
    return { online: rule?.online === true, offline: rule?.offline === true };
  }

  function follows(friendId) {
    const rule = ruleFor(friendId);
    return rule.online || rule.offline;
  }

  function friendState(friend) {
    return Object.hasOwn(stateLabels, friend.state) ? friend.state : "unknown";
  }

  function setText(id, text) {
    const element = byId(id);
    if (element) element.textContent = text;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function validTimestamp(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime());
  }

  function dateTime(value) {
    return validTimestamp(value) ? dateTimeFormat.format(new Date(value)) : "时间未知";
  }

  function verifiedProfileUrl(friendId) {
    // Never accept a stored URL or allow a user ID to change the origin/path.
    if (!/^(?:usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]{10})$/i.test(friendId)) return null;
    return `https://vrchat.com/home/user/${encodeURIComponent(friendId)}`;
  }

  function profileName(name, friendId) {
    const url = verifiedProfileUrl(friendId);
    const node = element(url ? "a" : "span", "friend-name", safeText(name, friendId));
    node.title = safeText(name, friendId);
    if (url) {
      node.href = url;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
      node.setAttribute("aria-label", `打开 ${safeText(name, friendId)} 的 VRChat 主页（新标签页）`);
      node.dataset.focusKey = `profile:${friendId}`;
    }
    return node;
  }

  function avatarFor(friend) {
    let hash = 0;
    for (const character of friend.id) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
    const initial = Array.from(safeText(friend.name, "?").trim())[0] || "?";
    const avatar = element("span", `friend-avatar avatar-${hash % 5}`, initial.toLocaleUpperCase("zh-CN"));
    avatar.setAttribute("aria-hidden", "true");
    return avatar;
  }

  function emptyState(title, description, symbol = "◌") {
    const node = element("div", "empty-state");
    const icon = element("div", "empty-symbol", symbol);
    icon.setAttribute("aria-hidden", "true");
    node.append(icon, element("h3", "", title), element("p", "", description));
    return node;
  }

  function replacePreservingFocus(container, content) {
    const active = document.activeElement;
    const focusKey = container.contains(active) ? active?.dataset?.focusKey : null;
    container.replaceChildren(content);
    if (focusKey) {
      const replacement = Array.from(container.querySelectorAll("[data-focus-key]")).find((node) => node.dataset.focusKey === focusKey);
      if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    }
  }

  function showFeedback(message, error = false) {
    const box = byId("actionFeedback");
    clearTimeout(feedbackTimer);
    box.textContent = message;
    box.classList.toggle("is-error", error);
    box.hidden = false;
    feedbackTimer = setTimeout(() => { box.hidden = true; }, error ? 12000 : 6500);
  }

  async function send(message) {
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error("无法连接扩展后台，请在浏览器扩展中打开此面板。");
    const response = await chrome.runtime.sendMessage(message);
    if (!response || response.ok !== true) {
      throw new Error(safeText(response?.error, "操作未完成，请稍后重试。"));
    }
    return response;
  }

  function applyState(nextState) {
    if (!nextState || typeof nextState !== "object") return;
    const previousAccountId = accountFor()?.id ?? null;
    const nextAccountId = accountFor(nextState)?.id ?? null;
    state = nextState;
    if (previousAccountId !== nextAccountId) {
      accountEpoch += 1;
      historyLimit = 150;
      friendsFingerprint = null;
      historyFingerprint = null;
      clearHistoryAccountId = null;
      const dialog = byId("clearHistoryDialog");
      if (dialog?.open) dialog.close("cancel");
      // Search text may contain a former account's friend names or IDs.
      if (previousAccountId) {
        for (const id of ["friendsSearch", "historySearch"]) if (byId(id)) byId(id).value = "";
        if (byId("selectedOnly")) byId("selectedOnly").checked = false;
        if (byId("friendState")) byId("friendState").value = "all";
        byId("actionFeedback").hidden = true;
      }
    }
    render();
  }

  async function loadState({ reportError = false } = {}) {
    const sequence = ++readSequence;
    const mutation = mutationSequence;
    try {
      const response = await send({ type: "getState" });
      if (!response.state) throw new Error("后台尚未返回监控状态，请重试。");
      if (sequence === readSequence && mutation === mutationSequence) applyState(response.state);
    } catch (error) {
      if (sequence !== readSequence) return;
      if (!state) {
        setText("connectionTitle", "暂时无法读取状态");
        setText("connectionMessage", "扩展后台暂未响应。点击立即同步重试，或重新打开扩展。");
        byId("statusDot").className = "status-dot status-retrying";
        byId("friendsList").setAttribute("aria-busy", "false");
        byId("friendsList").replaceChildren(emptyState("正在等待后台", "请稍后重试。"));
        if (byId("historyList")) {
          byId("historyList").setAttribute("aria-busy", "false");
          byId("historyList").replaceChildren(emptyState("动态暂未载入", "连接扩展后台后会在这里显示。"));
        }
      }
      if (reportError || !state) showFeedback(safeText(error?.message, "读取状态失败，请重试。"), true);
    }
  }

  function renderConnection() {
    if (!state) return;
    const connection = state.connection || {};
    const status = Object.hasOwn(statusLabels, connection.status) ? connection.status : "idle";
    const account = accountFor();
    const intervalMinutes = [1, 2, 5].includes(state.settings?.intervalMinutes) ? state.settings.intervalMinutes : 1;
    const cacheExpired = validTimestamp(connection.lastSuccessAt) && Date.now() - connection.lastSuccessAt > intervalMinutes * 60000 * 2 + 15000;
    setText("connectionTitle", statusLabels[status]);
    const httpStatus = ["retrying", "auth_required"].includes(status) && connection.errorKind === "http" && Number.isInteger(connection.errorStatus) &&
      connection.errorStatus >= 400 && connection.errorStatus <= 599 ? `（HTTP ${connection.errorStatus}）` : "";
    const message = safeText(connection.message) || (account ? "请保留 VRChat 官网标签页，好友状态会按照同步间隔自动更新。" : "请打开并保留 VRChat 官网标签页，完成登录后再回到这里同步。");
    setText("connectionMessage", message + httpStatus);
    byId("statusDot").className = `status-dot status-${status}`;
    byId("staleBadge").hidden = !account || !(connection.stale === true || cacheExpired);
    const syncText = [];
    if (!account) {
      syncText.push("登录后开始同步好友状态");
    } else {
      syncText.push(validTimestamp(connection.lastSuccessAt) ? `上次同步 ${dateTime(connection.lastSuccessAt)}` : "尚未完成首次同步");
    }
    if (validTimestamp(connection.nextAttemptAt) && connection.nextAttemptAt > Date.now() && (state.settings?.enabled || status === "retrying")) {
      const label = status === "retrying" ? "下次尝试" : status === "auth_required" ? "下次登录检查" : "下次同步";
      syncText.push(`${label} ${clockFormat.format(new Date(connection.nextAttemptAt))}`);
    } else if (status === "retrying" && validTimestamp(connection.nextAttemptAt)) {
      syncText.push("下次尝试 即将开始");
    }
    setText("lastSync", syncText.join(" · "));
    setText("accountName", account ? safeText(account.name, account.id) : "未连接账号");
    byId("accountName").title = account ? safeText(account.name, account.id) : "请先登录 VRChat 官网";
    const login = byId("openLoginButton");
    if (isPopup) login.hidden = !!account && !["auth_required", "retrying"].includes(status);
    else login.textContent = account ? "VRChat 官网 ↗" : "登录 VRChat ↗";
    const warning = byId("notificationWarning");
    warning.hidden = !account || !state.notificationWarning;
    warning.textContent = account ? safeText(state.notificationWarning) : "";
    const isSyncing = refreshPending || status === "syncing";
    byId("refreshButton").disabled = isSyncing;
    byId("refreshButton").setAttribute("aria-busy", String(isSyncing));
    byId("refreshButton").title = isSyncing ? "正在同步" : "立即同步好友状态";
    setText("refreshLabel", isSyncing ? "同步中…" : "立即同步");
  }

  function renderSettings() {
    if (!state) return;
    const settings = state.settings || {};
    const enabled = settings.enabled === true;
    const toggle = byId("toggleMonitoring");
    toggle.disabled = settingsPending;
    toggle.textContent = settingsPending ? "保存中…" : enabled ? "暂停监控" : "开启监控";
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.setAttribute("aria-label", enabled ? "监控已开启，点击暂停监控" : "监控已暂停，点击开启监控");
    const interval = byId("intervalMinutes");
    if (interval) {
      interval.value = [1, 2, 5].includes(settings.intervalMinutes) ? String(settings.intervalMinutes) : "1";
      interval.disabled = settingsPending;
    }
    const notifications = byId("notificationsEnabled");
    if (notifications) {
      notifications.checked = settings.notificationsEnabled === true;
      notifications.disabled = settingsPending;
    }
    setText("monitorHint", enabled ? "按设定间隔自动同步" : "自动同步已暂停，可手动同步");
    const clearHistory = byId("clearHistoryButton");
    if (clearHistory) clearHistory.disabled = historyPending || !accountFor() || currentEvents().length === 0;
  }

  function renderSummary() {
    const friends = currentFriends();
    for (const status of ["game", "web", "offline"]) {
      setText(`${status}Count`, accountFor() ? String(friends.filter((friend) => friendState(friend) === status).length) : "—");
    }
    const selected = friends.filter((friend) => follows(friend.id)).length;
    setText("selectedCount", String(isPopup ? selected : friends.length));
    byId("selectedCount").setAttribute("aria-label", isPopup ? `已关注 ${selected} 位好友` : `共 ${friends.length} 位好友`);
  }

  function buildFriendRow(friend) {
    const row = element("div", "friend-row");
    row.setAttribute("role", "listitem");
    const main = element("div", "friend-main");
    main.append(profileName(friend.name, friend.id));
    if (!isPopup) {
      const meta = element("div", "friend-meta");
      const id = element("span", "friend-id", friend.id);
      id.title = friend.id;
      const copy = element("button", "text-button copy-button", "复制");
      copy.type = "button";
      copy.dataset.action = "copy";
      copy.dataset.friendId = friend.id;
      copy.dataset.focusKey = `copy:${friend.id}`;
      copy.setAttribute("aria-label", `复制 ${safeText(friend.name, friend.id)} 的用户 ID`);
      meta.append(id, copy);
      main.append(meta);
    }
    const status = friendState(friend);
    const badge = element("span", `friend-state state-${status}`, stateLabels[status]);
    if (status === "web") badge.title = "网页或其他非游戏客户端处于活跃状态";
    row.append(avatarFor(friend), main, badge);
    if (!isPopup) {
      const rule = ruleFor(friend.id);
      const rules = element("div", "friend-rules");
      rules.setAttribute("role", "group");
      rules.setAttribute("aria-label", `${safeText(friend.name, friend.id)} 的游戏状态提醒`);
      for (const [key, labelText] of [["online", "上线"], ["offline", "离线"]]) {
        const label = element("label", "checkbox-label");
        const checkbox = element("input");
        checkbox.type = "checkbox";
        checkbox.checked = rule[key];
        checkbox.disabled = pendingRules.has(friend.id);
        checkbox.dataset.action = "set-rule";
        checkbox.dataset.friendId = friend.id;
        checkbox.dataset.rule = key;
        checkbox.dataset.focusKey = `rule:${friend.id}:${key}`;
        checkbox.setAttribute("aria-label", `${safeText(friend.name, friend.id)} 游戏${labelText}时通知`);
        label.append(checkbox, document.createTextNode(labelText));
        rules.append(label);
      }
      row.append(rules);
    }
    return row;
  }

  function renderFriends() {
    const account = accountFor();
    const friends = currentFriends();
    const query = safeText(byId("friendsSearch")?.value).trim().toLocaleLowerCase("zh-CN");
    const stateFilter = byId("friendState")?.value || "all";
    const selectedOnly = byId("selectedOnly")?.checked === true;
    const selected = friends.filter((friend) => follows(friend.id));
    let filtered;
    if (isPopup) {
      filtered = selected.length ? selected : friends.filter((friend) => ["game", "web"].includes(friendState(friend)));
      setText("popupFriendsTitle", selected.length ? "关注中的好友" : "当前活跃的好友");
      setText("popupFriendsHint", selected.length ? `已关注 ${selected.length} 位好友${selected.length > 5 ? "，显示前 5 位" : ""}` : "在完整面板中为好友设置上线与离线提醒。");
    } else {
      filtered = friends.filter((friend) => {
        const matchesName = `${safeText(friend.name)} ${friend.id}`.toLocaleLowerCase("zh-CN").includes(query);
        return matchesName && (stateFilter === "all" || friendState(friend) === stateFilter) && (!selectedOnly || follows(friend.id));
      });
      setText("friendsSummary", account ? `共 ${friends.length} 位 · 已设置提醒 ${selected.length} 位 · 当前显示 ${filtered.length} 位` : "登录后载入好友列表");
    }
    filtered = [...filtered].sort((left, right) => {
      const statusDifference = stateOrder[friendState(left)] - stateOrder[friendState(right)];
      return statusDifference || Number(follows(right.id)) - Number(follows(left.id)) || safeText(left.name, left.id).localeCompare(safeText(right.name, right.id), "zh-CN", { numeric: true });
    });
    if (isPopup) filtered = filtered.slice(0, 5);

    const fingerprint = JSON.stringify([account?.id, filtered.map((friend) => [friend.id, friend.name, friendState(friend), ruleFor(friend.id), pendingRules.has(friend.id)]), query, stateFilter, selectedOnly, !!state, state?.connection?.status, friends.length]);
    if (fingerprint === friendsFingerprint) return;
    friendsFingerprint = fingerprint;
    const container = byId("friendsList");
    container.setAttribute("aria-busy", String(!state));
    const content = document.createDocumentFragment();
    if (!state) content.append(emptyState("正在载入好友", "正在读取扩展的监控状态。"));
    else if (!account) content.append(emptyState("先连接你的 VRChat 账号", "在官网完成登录，再点击立即同步。"));
    else if (!friends.length) content.append(emptyState("暂未获取到好友", state.connection?.lastSuccessAt ? "当前账号还没有可显示的好友。" : "首次同步完成后，好友会出现在这里。"));
    else if (!filtered.length && isPopup) content.append(emptyState("暂时没有活跃的好友", "打开完整面板，设置你想关注的好友。"));
    else if (!filtered.length) content.append(emptyState("没有符合条件的好友", "试试其他昵称、用户 ID，或调整筛选条件。"));
    else for (const friend of filtered) content.append(buildFriendRow(friend));
    replacePreservingFocus(container, content);
  }

  function renderHistory() {
    const container = byId("historyList");
    if (!container) return;
    const account = accountFor();
    const events = currentEvents();
    const query = safeText(byId("historySearch")?.value).trim().toLocaleLowerCase("zh-CN");
    const filtered = events.filter((event) => `${safeText(event.name)} ${event.friendId} ${event.online ? "游戏上线" : "游戏离线"} ${dateTime(event.at)}`.toLocaleLowerCase("zh-CN").includes(query)).sort((left, right) => (Number(right.at) || 0) - (Number(left.at) || 0));
    const visible = filtered.slice(0, historyLimit);
    setText("historySummary", account ? `共 ${events.length} 条 · 显示 ${visible.length}${visible.length < filtered.length ? ` / ${filtered.length}` : ""} 条` : "登录后查看当前账号的动态");
    byId("loadMoreHistory").hidden = visible.length >= filtered.length;
    const fingerprint = JSON.stringify([account?.id, visible, query, !!state, events.length]);
    if (fingerprint === historyFingerprint) return;
    historyFingerprint = fingerprint;
    container.setAttribute("aria-busy", String(!state));
    const content = document.createDocumentFragment();
    if (!state) content.append(emptyState("正在载入动态", "正在读取扩展的监控状态。"));
    else if (!account) content.append(emptyState("登录后开始记录", "此处只显示当前账号的好友动态。"));
    else if (!events.length) content.append(emptyState("还没有新的动态", "首次同步只建立基线；之后检测到的游戏上线与离线会记录在这里。"));
    else if (!visible.length) content.append(emptyState("没有找到相关动态", "试试其他昵称、ID，或搜索「上线」「离线」。"));
    else for (const event of visible) {
      const row = element("div", "history-row");
      row.setAttribute("role", "listitem");
      const symbol = element("span", `event-symbol${event.online ? "" : " event-offline"}`, event.online ? "↑" : "↓");
      symbol.setAttribute("aria-hidden", "true");
      const main = element("div", "event-content");
      const top = element("div", "event-top");
      top.append(profileName(event.name, event.friendId), element("span", `event-type${event.online ? "" : " event-type-offline"}`, event.online ? "游戏上线" : "游戏离线"));
      const time = element("time", "event-time", dateTime(event.at));
      if (validTimestamp(event.at)) {
        time.dateTime = new Date(event.at).toISOString();
        time.title = new Date(event.at).toLocaleString("zh-CN", { hour12: false });
      }
      main.append(top, time);
      row.append(symbol, main);
      content.append(row);
    }
    replacePreservingFocus(container, content);
  }

  function render() {
    renderConnection();
    renderSettings();
    renderSummary();
    renderFriends();
    renderHistory();
  }

  async function updateSettings(patch) {
    if (!state || settingsPending) return;
    settingsPending = true;
    mutationSequence += 1;
    const epoch = accountEpoch;
    renderSettings();
    try {
      const response = await send({ type: "updateSettings", settings: patch });
      if (response.state && epoch === accountEpoch) applyState(response.state);
    } catch (error) {
      showFeedback(safeText(error?.message, "设置未保存，请重试。"), true);
    } finally {
      settingsPending = false;
      renderSettings();
      await loadState();
    }
  }

  async function setRule(friendId, key, value) {
    const account = accountFor();
    if (!account || pendingRules.has(friendId) || !["online", "offline"].includes(key)) return;
    const nextRule = { ...ruleFor(friendId), [key]: value };
    const epoch = accountEpoch;
    const focusKey = `rule:${friendId}:${key}`;
    pendingRules.add(friendId);
    mutationSequence += 1;
    renderFriends();
    try {
      const response = await send({ type: "setRule", accountId: account.id, friendId, online: nextRule.online, offline: nextRule.offline });
      if (response.state && epoch === accountEpoch) applyState(response.state);
    } catch (error) {
      if (epoch === accountEpoch) showFeedback(safeText(error?.message, "提醒设置未保存，请重试。"), true);
    } finally {
      pendingRules.delete(friendId);
      renderFriends();
      // A disabled input cannot keep focus while its update is in progress.
      if (epoch === accountEpoch && document.activeElement === document.body) {
        const input = Array.from(byId("friendsList").querySelectorAll("[data-focus-key]")).find((node) => node.dataset.focusKey === focusKey);
        input?.focus({ preventScroll: true });
      }
      await loadState();
    }
  }

  async function refresh() {
    if (refreshPending) return;
    const previousSuccessAt = state?.connection?.lastSuccessAt;
    refreshPending = true;
    mutationSequence += 1;
    renderConnection();
    try {
      const response = await send({ type: "refresh" });
      if (response.state) applyState(response.state);
      const connection = response.state?.connection;
      if (validTimestamp(connection?.retryUntil) && connection.retryUntil > Date.now()) {
        showFeedback(`服务器要求等待，请在 ${clockFormat.format(new Date(connection.retryUntil))} 后重试。`);
      } else if (["retrying", "auth_required"].includes(connection?.status) && validTimestamp(connection.lastAttemptAt) &&
          Date.now() - connection.lastAttemptAt < 30000 && !["site_required", "site_reload_required"].includes(connection.errorKind)) {
        showFeedback("本次同步尚未完成；请查看连接提示，修复后间隔 30 秒再次同步。", true);
      }
      if (validTimestamp(previousSuccessAt) && previousSuccessAt === response.state?.connection?.lastSuccessAt && ["connected", "paused"].includes(response.state?.connection?.status)) {
        showFeedback("当前为最近一次同步结果；请稍后再刷新。");
      }
    } catch (error) {
      showFeedback(safeText(error?.message, "同步未完成，请稍后重试。"), true);
    } finally {
      refreshPending = false;
      renderConnection();
      await loadState({ reportError: true });
    }
  }

  async function openPage(type) {
    try { await send({ type }); }
    catch (error) { showFeedback(safeText(error?.message, "无法打开页面，请重试。"), true); }
  }

  async function clearHistory(accountId) {
    if (!accountId || accountId !== accountFor()?.id || historyPending) return;
    const epoch = accountEpoch;
    historyPending = true;
    mutationSequence += 1;
    renderSettings();
    try {
      const response = await send({ type: "clearHistory", accountId });
      if (response.state && epoch === accountEpoch) applyState(response.state);
      if (epoch === accountEpoch) showFeedback("当前账号的动态记录已清空。");
    } catch (error) {
      if (epoch === accountEpoch) showFeedback(safeText(error?.message, "动态记录未清空，请重试。"), true);
    } finally {
      historyPending = false;
      renderSettings();
      await loadState();
    }
  }

  byId("refreshButton").addEventListener("click", refresh);
  byId("openLoginButton").addEventListener("click", () => openPage("openLogin"));
  byId("openDashboardButton")?.addEventListener("click", () => openPage("openDashboard"));
  byId("toggleMonitoring").addEventListener("click", () => updateSettings({ enabled: state?.settings?.enabled !== true }));
  byId("intervalMinutes")?.addEventListener("change", (event) => updateSettings({ intervalMinutes: Number(event.target.value) }));
  byId("notificationsEnabled")?.addEventListener("change", (event) => updateSettings({ notificationsEnabled: event.target.checked }));
  byId("friendsSearch")?.addEventListener("input", renderFriends);
  byId("friendState")?.addEventListener("change", renderFriends);
  byId("selectedOnly")?.addEventListener("change", renderFriends);
  byId("historySearch")?.addEventListener("input", () => { historyLimit = 150; renderHistory(); });
  byId("loadMoreHistory")?.addEventListener("click", () => { historyLimit += 150; renderHistory(); });

  byId("friendsList").addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.dataset.action === "set-rule") setRule(input.dataset.friendId, input.dataset.rule, input.checked);
  });
  byId("friendsList").addEventListener("click", async (event) => {
    const button = event.target.closest?.("button[data-action='copy']");
    if (!button || !accountFor() || !currentFriends().some((friend) => friend.id === button.dataset.friendId)) return;
    try {
      await navigator.clipboard.writeText(button.dataset.friendId);
      showFeedback("已复制用户 ID。");
    } catch {
      showFeedback("复制未完成。你可以选中好友昵称下方的用户 ID 手动复制。", true);
    }
  });

  const dialog = byId("clearHistoryDialog");
  byId("clearHistoryButton")?.addEventListener("click", () => {
    clearHistoryAccountId = accountFor()?.id ?? null;
    if (clearHistoryAccountId && dialog) dialog.showModal();
  });
  dialog?.addEventListener("close", () => {
    const accountId = clearHistoryAccountId;
    clearHistoryAccountId = null;
    if (dialog.returnValue === "confirm") clearHistory(accountId);
  });

  if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener(() => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => loadState(), 120);
    });
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadState(); });
  setInterval(() => { if (!document.hidden) renderConnection(); }, 15000);
  render();
  loadState();
})();
