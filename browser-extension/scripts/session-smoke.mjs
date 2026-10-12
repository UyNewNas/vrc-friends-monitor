import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { EXTENSION_ROOT } from "./project-files.mjs";

// This loads the actual MV3 extension in a new profile. A loopback-only HTTPS
// fixture observes real browser cookies and Fetch Metadata. The CONNECT proxy
// never forwards traffic to the Internet, including traffic from Chrome itself.
// The certificate/key and the profile are generated temporarily and removed.
const candidates = [process.env.VRC_MONITOR_CHROME, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].filter(Boolean);
const executable = candidates.find((candidate) => spawnSync(candidate, ["--version"], { timeout: 5000, stdio: "ignore" }).status === 0);
if (!executable) {
  console.error("Chrome/Chromium was not found. Set VRC_MONITOR_CHROME to run the installed-extension session smoke test.");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "vrc-monitor-session-"));
const fixtureOrigin = "https://vrchat.com";
const fixtureCookie = "vrc_monitor_fixture=session-present";
const privateMarker = "synthetic-private-marker";
const accountId = "usr_00000000-0000-4000-8000-000000000001";
const accountName = "Synthetic Session Account";
const roster = Array.from({ length: 102 }, (_, index) => ({
  id: `usr_00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
  displayName: `Synthetic Friend ${String(index + 1).padStart(3, "0")}`,
  fixturePrivateField: privateMarker,
}));
const identity = {
  id: accountId, displayName: accountName,
  friends: roster.map((friend) => friend.id),
  onlineFriends: roster.slice(0, 101).map((friend) => friend.id),
  activeFriends: [], offlineFriends: [roster[101].id],
  fixturePrivateField: privateMarker,
};
const apiRequests = [];
const browserErrors = [];
const sockets = new Set();
const pending = new Map();
let nextId = 0;
let child;
let fixtureServer;
let proxy;
let finishing = false;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function trackSocket(socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function serveFixture(request, response) {
  const url = new URL(request.url, fixtureOrigin);
  if (request.headers.host !== "vrchat.com" || url.origin !== fixtureOrigin) {
    response.writeHead(421).end();
    return;
  }
  if (request.method === "GET" && (url.pathname === "/home" || url.pathname.startsWith("/home/"))) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Set-Cookie": `${fixtureCookie}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      "Content-Security-Policy": "default-src 'none'; connect-src 'self'; base-uri 'none'",
    });
    response.end("<!doctype html><html lang=en><meta charset=utf-8><title>Synthetic website session</title><body><h1>Synthetic website session</h1><p>This page and its API responses are local test fixtures.</p></body></html>");
    return;
  }
  if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
  if (!["/api/1/auth/user", "/api/1/auth/user/friends"].includes(url.pathname)) {
    response.writeHead(404).end();
    return;
  }

  const observation = {
    path: url.pathname,
    offline: url.searchParams.get("offline"), offset: url.searchParams.get("offset"),
    method: request.method,
    cookieSent: request.headers.cookie?.split(/;\s*/).includes(fixtureCookie) === true,
    site: request.headers["sec-fetch-site"] || "",
    origin: request.headers.origin || "",
    websiteReferrer: request.headers.referer?.startsWith(`${fixtureOrigin}/home`) === true,
    status: 0,
  };
  apiRequests.push(observation);
  const reply = (status, payload) => { observation.status = status; json(response, status, payload); };
  // Reproduce the important boundary: an extension-origin request fails even
  // though the same profile has a valid, HttpOnly website login cookie.
  if (observation.site !== "same-origin") { reply(403, { error: { message: "Synthetic website-context requirement" } }); return; }
  if (!observation.cookieSent) { reply(401, { error: { message: "Synthetic session required" } }); return; }
  if (request.method !== "GET") { reply(405, {}); return; }
  if (url.pathname === "/api/1/auth/user") { reply(200, identity); return; }
  if (!["true", "false"].includes(observation.offline) || url.searchParams.get("n") !== "100" ||
      !/^(?:0|100)$/.test(observation.offset || "")) {
    reply(400, { error: { message: "Unexpected synthetic pagination" } });
    return;
  }
  const friends = observation.offline === "true" ? roster.slice(101) : roster.slice(0, 101);
  const offset = Number(observation.offset);
  reply(200, friends.slice(offset, offset + 100));
}

// Chrome's documented extension-loading CDP command uses the debugging pipe.
// Unlike --load-extension, it is available in branded Chrome as well as Chromium.
function send(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`, (error) => {
      if (error && pending.has(id)) {
        pending.delete(id); clearTimeout(timer); reject(new Error("Chrome debugging pipe failed."));
      }
    });
  });
}

function receive(message) {
  if (message.id && pending.has(message.id)) {
    const request = pending.get(message.id);
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`CDP command failed: ${message.error.message}`));
    else request.resolve(message.result);
  } else if (message.method === "Runtime.exceptionThrown") {
    browserErrors.push("Uncaught exception in an observed browser context");
  }
}

async function evaluate(sessionId, expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error("Installed-extension smoke evaluation failed.");
  return result.result.value;
}

async function waitFor(sessionId, expression, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(sessionId, expression)) return;
    await delay(100);
  }
  throw new Error(`Installed extension did not reach expected state: ${label}`);
}

async function page(url) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url }, sessionId);
  await waitFor(sessionId, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, "page load");
  return { sessionId, targetId };
}

try {
  const certificatePath = join(profile, "fixture-cert.pem");
  const keyPath = join(profile, "fixture-key.pem");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-days", "1", "-subj", "/CN=vrchat.com", "-addext", "subjectAltName=DNS:vrchat.com",
    "-keyout", keyPath, "-out", certificatePath], { timeout: 15000, stdio: "ignore" });
  assert.equal(generated.status, 0, "OpenSSL must create a disposable certificate for the loopback-only HTTPS fixture");
  const certificate = readFileSync(certificatePath);
  const publicKey = new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" });
  const spki = createHash("sha256").update(publicKey).digest("base64");
  fixtureServer = createHttpsServer({ key: readFileSync(keyPath), cert: certificate }, serveFixture);
  fixtureServer.on("connection", trackSocket);
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));

  proxy = createHttpServer((_request, response) => response.writeHead(502).end());
  proxy.on("connection", trackSocket);
  proxy.on("connect", (request, client, head) => {
    // This is the complete routing table. No URL or host is resolved externally.
    if (request.url !== "vrchat.com:443") { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
    const local = trackSocket(connect(fixtureServer.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) local.write(head);
      client.pipe(local); local.pipe(client);
    }));
    client.once("close", () => local.destroy());
    local.once("close", () => client.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));

  child = spawn(executable, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-quic",
    "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`,
    `--proxy-server=http://127.0.0.1:${proxy.address().port}`, "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", `--ignore-certificate-errors-spki-list=${spki}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  child.stderr.resume();
  child.stdio[3].on("error", () => {});
  const failed = () => {
    if (finishing) return;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Chrome exited during the installed-extension test.")); }
    pending.clear();
  };
  child.once("error", failed); child.once("exit", failed);
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  child.stdio[4].on("data", (chunk) => {
    buffered += decoder.write(chunk);
    let end;
    while ((end = buffered.indexOf("\0")) >= 0) {
      const message = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (message) receive(JSON.parse(message));
    }
  });
  await send("Browser.getVersion");

  // The already logged-in tab deliberately predates installation. Static
  // content scripts need a page reload, which is part of the upgrade guidance.
  const website = await page(`${fixtureOrigin}/home`);
  assert.equal(await evaluate(website.sessionId, "document.cookie"), "", "The website fixture cookie is HttpOnly");
  const { id: extensionId } = await send("Extensions.loadUnpacked", { path: EXTENSION_ROOT });
  assert.match(extensionId, /^[a-p]{32}$/, "Chrome actually installed the unpacked extension");
  const dashboard = await page(`chrome-extension://${extensionId}/dashboard.html`);
  const stateExpression = "chrome.runtime.sendMessage({ type: 'getState' }).then(reply => reply.state)";
  await waitFor(dashboard.sessionId,
    `${stateExpression}.then(state => state?.connection?.lastAttemptAt && state.connection.status !== 'syncing')`,
    "initial existing-tab check");
  const beforeReload = await evaluate(dashboard.sessionId, stateExpression);
  assert.equal(beforeReload.account, null, "An old website document must not masquerade as a connected session");
  assert.equal(beforeReload.connection.stale, true, "Missing website transport is reported as stale");
  assert.equal(apiRequests.length, 0, "A missing website bridge makes no background API requests");

  const directStatus = await evaluate(dashboard.sessionId,
    "fetch('https://vrchat.com/api/1/auth/user', { credentials: 'include', cache: 'no-store' }).then(response => response.status)");
  assert.equal(directStatus, 403, "A direct extension request is rejected despite an existing website session");

  const previousDocument = await evaluate(website.sessionId, "performance.timeOrigin");
  await send("Page.reload", { ignoreCache: true }, website.sessionId);
  await waitFor(website.sessionId, `performance.timeOrigin !== ${previousDocument} && document.readyState === 'complete'`, "website reload");
  // The missing-bridge check did not reach the API, so reloading the website
  // allows an immediate retry. No clock, storage, runtime or fetch is replaced.
  await evaluate(dashboard.sessionId, "document.getElementById('refreshButton').click()");
  await waitFor(dashboard.sessionId,
    `document.getElementById('accountName')?.textContent === ${JSON.stringify(accountName)} && document.querySelectorAll('#friendsList .friend-row').length === 102`,
    "website session synced all paginated friends", 20000);
  const synced = await evaluate(dashboard.sessionId, stateExpression);
  assert.equal(synced.connection.status, "connected", "Actual background monitor became connected");
  assert.equal(synced.connection.stale, false, "Successful sync cleared stale data state");
  assert.equal(synced.account.id, accountId, "The correct synthetic website account was selected");
  assert.equal(synced.friends.length, 102, "Both online pages and the offline page are included");
  assert.equal(synced.events.length, 0, "First synchronization establishes a silent baseline");
  assert.equal(await evaluate(dashboard.sessionId, "document.getElementById('gameCount').textContent"), "101");
  assert.equal(await evaluate(dashboard.sessionId, "document.getElementById('offlineCount').textContent"), "1");

  const successful = apiRequests.filter((request) => request.status === 200);
  assert.ok(successful.length >= 5, "Authentication was checked before and after the paginated roster");
  assert.ok(successful.every((request) => request.cookieSent && request.site === "same-origin" &&
    request.websiteReferrer && (!request.origin || request.origin === fixtureOrigin) && request.method === "GET"),
  "Successful requests used the real website origin, referrer and browser-managed cookie");
  for (const [offline, offset] of [["false", "0"], ["false", "100"], ["true", "0"]]) {
    assert.ok(successful.some((request) => request.offline === offline && request.offset === offset), "Expected paginated website request reached the local fixture");
  }
  const stored = await evaluate(dashboard.sessionId, "chrome.storage.local.get(null).then(value => JSON.stringify(value))");
  assert.ok(!stored.includes(privateMarker) && !stored.includes(fixtureCookie) && !stored.includes("session-present"),
    "Only sanitized account/friend data was stored; cookies and extra payload fields were discarded");
  assert.deepEqual(browserErrors, [], "No uncaught exceptions in the real extension dashboard or website page");

  console.log("Installed-extension session smoke passed: actual MV3 loading, existing-tab reload, direct-origin 403, website-origin HttpOnly cookie authentication, full pagination and sanitized storage.");
  console.log("Scope: disposable profile and loopback-only synthetic HTTPS; this does not verify a real VRChat account or its current server policies.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  finishing = true;
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Installed-extension smoke finished.")); }
  pending.clear();
  child?.kill();
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  await delay(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
