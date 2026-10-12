import { readdirSync } from "node:fs";
import { extname, join, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { EXTENSION_ROOT, RUNTIME_FILES, TOOL_FILES, readSafeFile } from "./project-files.mjs";

const PERMISSIONS = ["alarms", "notifications", "storage"];
const HOSTS = ["https://vrchat.com/*", "https://api.vrchat.cloud/*"];
const SENSITIVE_CONTENT = [
  /[A-Z]:[\\/](?:Users|[^\\/]+[\\/]Documents)[\\/]/i,
  /(?<![A-Za-z0-9.:/])\/(?:Users|home)\/[^/\s]+\//i,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /authcookie_[A-Za-z0-9-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function sameItems(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

export function checkProject({ quiet = false } = {}) {
  const errors = [];
  const contents = new Map();
  const requireCondition = (condition, message) => { if (!condition) errors.push(message); };
  requireCondition(Number(process.versions.node.split(".")[0]) >= 22, "Node.js 22 or newer is required.");
  for (const name of [...RUNTIME_FILES, "package.json", "README.md", ...TOOL_FILES]) {
    try {
      const data = readSafeFile(name);
      requireCondition(data.length > 0, `Empty source file: ${name}`);
      contents.set(name, data);
      if (!name.endsWith(".png")) {
        requireCondition(!SENSITIVE_CONTENT.some((pattern) => pattern.test(data.toString("utf8"))),
          `Potential private data in: ${name}`);
      }
    } catch {
      errors.push(`Missing or unsafe source file: ${name}`);
    }
  }

  let manifest;
  let metadata;
  for (const name of ["manifest.json", "package.json"]) {
    try {
      const parsed = JSON.parse(contents.get(name)?.toString("utf8"));
      if (name === "manifest.json") manifest = parsed;
      else metadata = parsed;
    } catch {
      errors.push(`Invalid JSON: ${name}`);
    }
  }

  const reference = (source, resource) => {
    if (typeof resource !== "string" || !resource || resource.includes("\\") ||
        resource.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(resource) || resource.includes("?")) {
      errors.push(`Nonlocal or invalid resource referenced by: ${source}`);
      return;
    }
    const target = posix.normalize(posix.join(posix.dirname(source), resource.split("#")[0]));
    requireCondition(RUNTIME_FILES.includes(target) && contents.has(target),
      `Missing or unpackaged resource in ${source}: ${target}`);
  };

  if (manifest) {
    requireCondition(manifest.manifest_version === 3, "Only Manifest V3 is supported.");
    requireCondition(typeof manifest.name === "string" && manifest.name.trim().length > 0,
      "The manifest needs an extension name.");
    requireCondition(/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version ?? "") &&
      manifest.version.split(".").every((part) => Number(part) <= 65535 && String(Number(part)) === part),
    "Invalid Chromium extension version.");
    requireCondition(/^\d+(?:\.\d+)*$/.test(manifest.minimum_chrome_version ?? "") &&
      Number(manifest.minimum_chrome_version.split(".")[0]) >= 120,
    "minimum_chrome_version must be at least 120.");
    requireCondition(sameItems(manifest.permissions, PERMISSIONS),
      "Permissions must be exactly storage, alarms and notifications.");
    requireCondition(manifest.incognito === "not_allowed", "Incognito access must remain disabled.");
    requireCondition(sameItems(manifest.host_permissions, HOSTS),
      "Host access must be limited to the official website and its API redirect target.");
    for (const forbidden of ["content_scripts", "optional_permissions", "optional_host_permissions",
      "externally_connectable", "web_accessible_resources", "sandbox", "oauth2", "update_url"]) {
      requireCondition(!(forbidden in manifest), `Unsupported manifest feature: ${forbidden}`);
    }
    requireCondition(manifest.background?.service_worker === "background.js" &&
      manifest.background?.type === "module", "Use the packaged module service worker.");
    requireCondition(manifest.action?.default_popup === "popup.html", "The action must open popup.html.");
    reference("manifest.json", manifest.background?.service_worker);
    reference("manifest.json", manifest.action?.default_popup);
    if (manifest.options_page) reference("manifest.json", manifest.options_page);
    if (manifest.options_ui?.page) reference("manifest.json", manifest.options_ui.page);
    for (const icons of [manifest.icons, manifest.action?.default_icon]) {
      if (typeof icons === "string") reference("manifest.json", icons);
      else if (icons && typeof icons === "object") {
        for (const icon of Object.values(icons)) reference("manifest.json", icon);
      }
    }
    const csp = manifest.content_security_policy?.extension_pages;
    requireCondition(typeof csp === "string", "Declare an explicit extension page CSP.");
    if (typeof csp === "string") {
      const entries = csp.split(";").map((entry) => entry.trim().split(/\s+/)).filter(([name]) => name);
      const directives = new Map(entries.map(([name, ...values]) => [name, values]));
      requireCondition(directives.size === entries.length, "CSP directives must not be duplicated.");
      requireCondition(!directives.has("script-src-elem") && !directives.has("script-src-attr"),
        "The CSP must not override the packaged-script restriction.");
      requireCondition(sameItems(directives.get("script-src"), ["'self'"]),
        "The CSP must restrict scripts to packaged files.");
      requireCondition(sameItems(directives.get("connect-src"), ["https://vrchat.com", "https://api.vrchat.cloud"]) ||
        sameItems(directives.get("connect-src"), ["'self'", "https://vrchat.com", "https://api.vrchat.cloud"]),
      "The CSP must restrict network connections to the official website and API redirect target.");
      requireCondition(sameItems(directives.get("object-src"), ["'none'"]),
        "The CSP must disable object embeds.");
      requireCondition(!/unsafe-eval|unsafe-inline|wasm-unsafe-eval|\*/.test(csp),
        "The CSP must not enable remote or evaluated code.");
    }
  }
  if (metadata) {
    requireCondition(metadata.private === true && metadata.type === "module",
      "The tooling package must remain private and use ES modules.");
    requireCondition(metadata.version === manifest?.version, "package.json and manifest.json versions must match.");
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      requireCondition(!metadata[field] || Object.keys(metadata[field]).length === 0,
        "Extension tooling must work without npm dependencies.");
    }
  }

  for (const [name, data] of contents) {
    if (!RUNTIME_FILES.includes(name)) continue;
    if (name.endsWith(".png")) {
      const size = Number(/icon(\d+)\.png$/.exec(name)?.[1]);
      requireCondition(data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        data.toString("ascii", 12, 16) === "IHDR" && data.readUInt32BE(16) === size && data.readUInt32BE(20) === size,
      `Invalid PNG dimensions: ${name}`);
      continue;
    }
    const source = data.toString("utf8");
    if (name.endsWith(".js")) {
      requireCondition(!/\b(?:eval|Function|importScripts)\s*\(/.test(source), `Evaluated code is forbidden: ${name}`);
      requireCondition(!/\b(?:chrome|browser)\s*\.\s*(?:cookies|debugger|webRequest|scripting)\b|\bdocument\s*\.\s*cookie\b/.test(source),
        `Direct cookie access or privileged injection is forbidden: ${name}`);
      for (const pattern of [
        /\bimport\s+(?:[^"'();]*?\bfrom\s*)?["']([^"']+)["']/g,
        /\bexport\s+(?:\*|\{[^}]*\})\s+from\s*["']([^"']+)["']/g,
      ]) {
        for (const match of source.matchAll(pattern)) reference(name, match[1]);
      }
      const dynamicImports = [...source.matchAll(/\bimport\s*\(/g)];
      const literalImports = [...source.matchAll(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g)];
      requireCondition(dynamicImports.length === literalImports.length, `Computed module imports are forbidden: ${name}`);
      for (const match of literalImports) reference(name, match[2]);
    }
    if (name.endsWith(".html")) {
      requireCondition(!/\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*javascript:/i.test(source),
        `Inline JavaScript is forbidden: ${name}`);
      for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1]);
        requireCondition(Boolean(src) && match[2].trim() === "", `Use an external packaged script in: ${name}`);
        if (src) reference(name, src[1]);
      }
      for (const match of source.matchAll(/<(?:link|img)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
        reference(name, match[1]);
      }
    }
    if (name.endsWith(".css")) {
      requireCondition(!/@import\b/i.test(source), `CSS imports are forbidden: ${name}`);
      for (const match of source.matchAll(/url\(\s*["']?([^\s)"']+)["']?\s*\)/gi)) reference(name, match[1]);
    }
  }

  let testFiles = [];
  try {
    testFiles = readdirSync(join(EXTENSION_ROOT, "tests"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-z0-9-]+\.test\.mjs$/i.test(entry.name))
      .map((entry) => `tests/${entry.name}`);
  } catch {
    errors.push("Missing offline tests directory.");
  }
  requireCondition(testFiles.length > 0, "At least one offline behavior test is required.");
  for (const name of [...RUNTIME_FILES.filter((file) => extname(file) === ".js"), ...TOOL_FILES, ...testFiles]) {
    try {
      const data = readSafeFile(name);
      requireCondition(!SENSITIVE_CONTENT.some((pattern) => pattern.test(data.toString("utf8"))),
        `Potential private data in: ${name}`);
      const checked = spawnSync(process.execPath, ["--check", join(EXTENSION_ROOT, name)], { encoding: "utf8" });
      requireCondition(checked.status === 0, `Invalid JavaScript syntax: ${name}`);
    } catch {
      errors.push(`Missing or unsafe JavaScript: ${name}`);
    }
  }

  if (errors.length) throw new Error([...new Set(errors)].join("\n"));
  if (!quiet) console.log(`Extension checks passed: ${RUNTIME_FILES.length} runtime files, ${testFiles.length} offline test files; local code and restricted permissions verified.`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { checkProject(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
