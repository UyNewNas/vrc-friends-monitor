import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkProject } from "./check.mjs";
import { REPO_ROOT, packageFiles } from "./project-files.mjs";

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP_STORED avoids a dependency and compression-version differences. Fixed
// timestamps, permissions and ordering make identical sources byte-for-byte equal.
function deterministicZip(files) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0x0021, 12); // 1980-01-01, 00:00:00
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localRecords.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Unix, ZIP 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, name);
    offset += local.length + name.length + file.data.length;
  }
  const central = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, central, end]);
}

function verifyZip(archive, files) {
  const end = archive.subarray(-22);
  if (end.readUInt32LE(0) !== 0x06054b50 || end.readUInt16LE(10) !== files.length) {
    throw new Error("Invalid package directory.");
  }
  let directoryOffset = end.readUInt32LE(16);
  for (const file of files) {
    if (archive.readUInt32LE(directoryOffset) !== 0x02014b50) throw new Error("Invalid package entry.");
    const nameLength = archive.readUInt16LE(directoryOffset + 28);
    const name = archive.toString("utf8", directoryOffset + 46, directoryOffset + 46 + nameLength);
    const localOffset = archive.readUInt32LE(directoryOffset + 42);
    const dataOffset = localOffset + 30 + archive.readUInt16LE(localOffset + 26);
    const actual = archive.subarray(dataOffset, dataOffset + archive.readUInt32LE(directoryOffset + 24));
    if (name !== file.name || !actual.equals(file.data) || crc32(actual) !== archive.readUInt32LE(directoryOffset + 16)) {
      throw new Error("Package content differs from its runtime allowlist.");
    }
    directoryOffset += 46 + nameLength;
  }
  if (directoryOffset !== archive.length - 22) throw new Error("Unexpected package content.");
}

try {
  const manifest = checkProject();
  const files = packageFiles();
  const outputRoot = join(REPO_ROOT, "artifacts", "packages");
  mkdirSync(outputRoot, { recursive: true });
  const name = `VRC-Friends-Monitor-${manifest.version}-chromium.zip`;
  const target = join(outputRoot, name);
  const archive = deterministicZip(files);
  verifyZip(archive, files);
  writeFileSync(target, archive);
  const written = readFileSync(target);
  verifyZip(written, files);
  const sha256 = createHash("sha256").update(written).digest("hex");
  writeFileSync(`${target}.sha256`, `${sha256}  ${name}\n`, "utf8");
  console.log(`Package verified: artifacts/packages/${name} (${files.length} allowlisted files)`);
  console.log(`SHA-256: ${sha256}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
