import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function ensurePrivateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(directory, 0o700);
  }
  return directory;
}

const hardenedDataDirectories = new Set<string>();

function hardenExistingChildFiles(directory: string) {
  if (process.platform === "win32") return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(directory, entry.name);
    if (lstatSync(filePath).isFile()) chmodSync(filePath, 0o600);
  }
}

function packagedDataDir() {
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "RecruitAI");
  }
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      path.join(homedir(), "AppData", "Local");
    return path.join(base, "RecruitAI");
  }
  const base =
    process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(base, "recruit-ai");
}

export function getDataDir() {
  const configured = process.env.RECRUITAI_DATA_DIR;
  const resolved = configured
    ? path.resolve(configured)
    : typeof RECRUITAI_PACKAGED !== "undefined" && RECRUITAI_PACKAGED
      ? packagedDataDir()
      : path.resolve(process.cwd(), "data");
  ensurePrivateDirectory(resolved);
  if (!hardenedDataDirectories.has(resolved)) {
    for (const child of ["snapshots", "backups"]) {
      const directory = ensurePrivateDirectory(path.join(resolved, child));
      hardenExistingChildFiles(directory);
    }
    hardenedDataDirectories.add(resolved);
  }
  return resolved;
}

export function getDatabasePath() {
  return path.join(getDataDir(), "recruit-ai.sqlite");
}

export function getSnapshotsDir() {
  const resolved = path.join(getDataDir(), "snapshots");
  return ensurePrivateDirectory(resolved);
}
