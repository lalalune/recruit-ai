import {
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { getDataDir } from "./paths";

interface LockRecord {
  pid: number;
  token: string;
  createdAt: string;
}

let activeLock:
  | {
      filePath: string;
      token: string;
    }
  | null = null;

function processIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function existingLock(filePath: string): LockRecord | null {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<LockRecord>;
    return typeof value.pid === "number" &&
      typeof value.token === "string" &&
      typeof value.createdAt === "string"
      ? (value as LockRecord)
      : null;
  } catch {
    return null;
  }
}

export function releaseInstanceLock() {
  const current = activeLock;
  if (!current) return;
  activeLock = null;
  try {
    if (existingLock(current.filePath)?.token === current.token) {
      rmSync(current.filePath, { force: true });
    }
  } catch {
    // A missing data directory or lock file is already released.
  }
}

export function acquireInstanceLock() {
  if (activeLock) return activeLock.filePath;
  const filePath = path.join(getDataDir(), ".recruitai.lock");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = crypto.randomUUID();
    const temporaryPath = path.join(
      getDataDir(),
      `.recruitai-lock-${process.pid}-${token}.tmp`,
    );
    const record: LockRecord = {
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    };
    try {
      // Link a fully written same-directory file into the canonical path.
      // Unlike opening the canonical path and then writing, the winner is
      // atomic and another process can never observe a half-written lock.
      writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      linkSync(temporaryPath, filePath);
      rmSync(temporaryPath, { force: true });
      activeLock = { filePath, token };
      process.once("exit", releaseInstanceLock);
      return filePath;
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const record = existingLock(filePath);
      if (!record) {
        throw new Error(
          `The RecruitAI data lock is unreadable: ${filePath}. Remove it only after confirming no RecruitAI process is running.`,
        );
      }
      if (record && processIsAlive(record.pid)) {
        throw new Error(
          `RecruitAI is already using this local data directory (process ${record.pid}). Close the other instance before starting another.`,
        );
      }
      const quarantinePath = `${filePath}.stale-${crypto.randomUUID()}`;
      try {
        renameSync(filePath, quarantinePath);
        rmSync(quarantinePath, { force: true });
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw cleanupError;
        }
      }
    }
  }
  throw new Error("Could not acquire the RecruitAI local data lock.");
}
