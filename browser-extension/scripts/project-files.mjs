import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(EXTENSION_ROOT, "..");

// Every distributable file is named explicitly. Never archive an entire checkout
// or browser profile, even when an untracked file happens to be in this folder.
export const RUNTIME_FILES = Object.freeze([
  "manifest.json",
  "background.js",
  "api.js",
  "session.js",
  "site-bridge.js",
  "core.js",
  "monitor.js",
  "popup.html",
  "dashboard.html",
  "ui.js",
  "ui.css",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
]);

export const TOOL_FILES = Object.freeze([
  "scripts/project-files.mjs",
  "scripts/check.mjs",
  "scripts/package.mjs",
  "scripts/ui-smoke.mjs",
  "scripts/session-smoke.mjs",
]);

export function readSafeFile(relativePath, root = EXTENSION_ROOT) {
  if (!relativePath || relativePath.includes("\\") || relativePath.startsWith("/") ||
      relativePath.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new Error("Unsafe source path.");
  }
  const source = join(root, relativePath);
  if (!lstatSync(source).isFile() || realpathSync(source) !== source) {
    throw new Error(`Expected a regular source file: ${relativePath}`);
  }
  return readFileSync(source);
}

export function packageFiles() {
  const files = RUNTIME_FILES.map((name) => ({ name, data: readSafeFile(name) }));
  files.push({ name: "README.md", data: readSafeFile("README.md") });
  files.push({ name: "LICENSE", data: readSafeFile("LICENSE", REPO_ROOT) });
  return files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}
