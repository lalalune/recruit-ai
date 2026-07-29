import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  closeDatabase,
  getDatabase,
  newId,
  nowIso,
} from "./database";
import {
  getDataDir,
  getDatabasePath,
  getSnapshotsDir,
  ensurePrivateDirectory,
} from "./paths";
import { addAudit } from "./repository";

const backupFormat = "recruitai-local-backup";
const backupVersion = 1;
const snapshotFilePattern = /^[a-f0-9]{64}\.html$/;

interface BackupSnapshot {
  path: string;
  contentBase64: string;
}

interface BackupPayload {
  format: typeof backupFormat;
  version: typeof backupVersion;
  createdAt: string;
  appVersion: string;
  databaseBase64: string;
  snapshots: BackupSnapshot[];
}

function backupsDir() {
  const value = path.join(getDataDir(), "backups");
  return ensurePrivateDirectory(value);
}

function safeBackupPath(fileName: string) {
  const base = path.basename(fileName);
  if (base !== fileName || !/^recruitai-backup-[a-zA-Z0-9_.-]+\.json$/.test(base)) {
    throw new Error("Invalid backup file name.");
  }
  return path.join(backupsDir(), base);
}

function directorySize(directory: string): number {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory, { withFileTypes: true }).reduce(
    (total, entry) => {
      const entryPath = path.join(directory, entry.name);
      return (
        total +
        (entry.isDirectory() ? directorySize(entryPath) : statSync(entryPath).size)
      );
    },
    0,
  );
}

function snapshotPayloads(): BackupSnapshot[] {
  const root = getSnapshotsDir();
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      path: entry.name,
      contentBase64: readFileSync(path.join(root, entry.name)).toString("base64"),
    }));
}

function checkpointDatabase() {
  getDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

export function createFullBackup() {
  checkpointDatabase();
  const createdAt = nowIso();
  const safeTimestamp = createdAt.replace(/[:]/g, "-");
  const fileName = `recruitai-backup-${safeTimestamp}.json`;
  const payload: BackupPayload = {
    format: backupFormat,
    version: backupVersion,
    createdAt,
    appVersion: "0.1.0",
    databaseBase64: readFileSync(getDatabasePath()).toString("base64"),
    snapshots: snapshotPayloads(),
  };
  const filePath = safeBackupPath(fileName);
  writeFileSync(filePath, JSON.stringify(payload), {
    encoding: "utf8",
    mode: 0o600,
  });
  addAudit(
    "data.backup_created",
    "data",
    newId(),
    "Created a full local backup",
    { fileName, snapshots: payload.snapshots.length },
  );
  return {
    fileName,
    createdAt,
    bytes: statSync(filePath).size,
    snapshotCount: payload.snapshots.length,
    downloadUrl: `/api/data/backups/${encodeURIComponent(fileName)}`,
  };
}

export function listBackups() {
  return readdirSync(backupsDir(), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^recruitai-backup-[a-zA-Z0-9_.-]+\.json$/.test(entry.name),
    )
    .map((entry) => {
      const stat = statSync(path.join(backupsDir(), entry.name));
      return {
        fileName: entry.name,
        bytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        downloadUrl: `/api/data/backups/${encodeURIComponent(entry.name)}`,
      };
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function getBackupFile(fileName: string) {
  const filePath = safeBackupPath(fileName);
  if (!existsSync(filePath)) throw new Error("Backup not found.");
  return { filePath, fileName: path.basename(filePath) };
}

function parseBackup(backupText: string): BackupPayload {
  if (backupText.length > 500 * 1024 * 1024) {
    throw new Error("Backup exceeds the 500 MB local restore limit.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(backupText);
  } catch {
    throw new Error("The selected file is not valid JSON backup data.");
  }
  const candidate = payload as Partial<BackupPayload>;
  if (
    candidate.format !== backupFormat ||
    candidate.version !== backupVersion ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    typeof candidate.appVersion !== "string" ||
    typeof candidate.databaseBase64 !== "string" ||
    !Array.isArray(candidate.snapshots)
  ) {
    throw new Error("This is not a compatible RecruitAI backup.");
  }
  const snapshotNames = new Set<string>();
  for (const snapshot of candidate.snapshots) {
    if (
      !snapshot ||
      typeof snapshot.path !== "string" ||
      !snapshotFilePattern.test(snapshot.path) ||
      typeof snapshot.contentBase64 !== "string" ||
      snapshotNames.has(snapshot.path)
    ) {
      throw new Error("The backup contains an unsafe snapshot path.");
    }
    snapshotNames.add(snapshot.path);
  }
  return candidate as BackupPayload;
}

function decodeBase64(value: string, label: string) {
  if (!/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} contains invalid base64 data.`);
  }
  return Buffer.from(value, "base64");
}

function validateSqliteFile(filePath: string) {
  // A checkpointed SQLite database can still declare WAL journal mode in its
  // header. SQLite may need to create transient sidecars before a read-only
  // query can start, so open the already-created temp file read/write, then
  // immediately put the connection in query-only/untrusted-schema mode.
  const candidate = new Database(filePath, { readwrite: true, create: false });
  try {
    candidate.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    const tables = candidate
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('companies', 'contacts', 'jobs', 'evidence')`,
      )
      .all() as Array<{ name: string }>;
    if (tables.length !== 4) {
      throw new Error("Backup database is missing required RecruitAI tables.");
    }
    const integrity = candidate.query("PRAGMA integrity_check").get() as
      | { integrity_check: string }
      | null;
    if (integrity?.integrity_check !== "ok") {
      throw new Error("Backup database failed SQLite integrity validation.");
    }
  } finally {
    candidate.close();
    rmSync(`${filePath}-wal`, { force: true });
    rmSync(`${filePath}-shm`, { force: true });
  }
}

export function inspectBackup(backupText: string) {
  const payload = parseBackup(backupText);
  const databaseBytes = decodeBase64(payload.databaseBase64, "Backup database");
  if (databaseBytes.length < 100) {
    throw new Error("Backup database is empty or corrupt.");
  }
  for (const snapshot of payload.snapshots) {
    decodeBase64(snapshot.contentBase64, `Snapshot ${snapshot.path}`);
  }
  const tempPath = path.join(getDataDir(), `.inspect-${newId()}.sqlite`);
  writeFileSync(tempPath, databaseBytes, { mode: 0o600 });
  try {
    validateSqliteFile(tempPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
  return {
    format: payload.format,
    version: payload.version,
    createdAt: payload.createdAt,
    appVersion: payload.appVersion,
    databaseBytes: databaseBytes.length,
    snapshotCount: payload.snapshots.length,
  };
}

export function restoreFullBackup(backupText: string) {
  const payload = parseBackup(backupText);
  const databaseBytes = decodeBase64(payload.databaseBase64, "Backup database");
  if (databaseBytes.length < 100) {
    throw new Error("Backup database is empty or corrupt.");
  }
  const dataDirectory = getDataDir();
  const databasePath = getDatabasePath();
  const snapshotsPath = getSnapshotsDir();
  const restoreId = newId();
  const tempPath = path.join(dataDirectory, `.restore-${restoreId}.sqlite`);
  const rollbackPath = path.join(dataDirectory, `.rollback-${restoreId}.sqlite`);
  const tempSnapshotsPath = path.join(
    dataDirectory,
    `.restore-snapshots-${restoreId}`,
  );
  const rollbackSnapshotsPath = path.join(
    dataDirectory,
    `.rollback-snapshots-${restoreId}`,
  );
  writeFileSync(tempPath, databaseBytes, {
    mode: 0o600,
  });
  mkdirSync(tempSnapshotsPath, { recursive: false, mode: 0o700 });
  try {
    validateSqliteFile(tempPath);
    for (const snapshot of payload.snapshots) {
      writeFileSync(
        path.join(tempSnapshotsPath, snapshot.path),
        decodeBase64(snapshot.contentBase64, `Snapshot ${snapshot.path}`),
        { mode: 0o600 },
      );
    }
  } catch (error) {
    rmSync(tempPath, { force: true });
    rmSync(tempSnapshotsPath, { recursive: true, force: true });
    throw error;
  }

  const preRestore = createFullBackup();
  closeDatabase();
  let databaseSwapped = false;
  let snapshotsSwapped = false;
  try {
    if (existsSync(`${databasePath}-wal`)) rmSync(`${databasePath}-wal`);
    if (existsSync(`${databasePath}-shm`)) rmSync(`${databasePath}-shm`);
    if (existsSync(databasePath)) renameSync(databasePath, rollbackPath);
    renameSync(tempPath, databasePath);
    if (process.platform !== "win32") chmodSync(databasePath, 0o600);
    databaseSwapped = true;
    if (existsSync(snapshotsPath)) {
      renameSync(snapshotsPath, rollbackSnapshotsPath);
    }
    renameSync(tempSnapshotsPath, snapshotsPath);
    snapshotsSwapped = true;
    getDatabase();
    if (existsSync(rollbackPath)) rmSync(rollbackPath);
    if (existsSync(rollbackSnapshotsPath)) {
      rmSync(rollbackSnapshotsPath, { recursive: true, force: true });
    }
  } catch (error) {
    closeDatabase();
    if (snapshotsSwapped && existsSync(snapshotsPath)) {
      rmSync(snapshotsPath, { recursive: true, force: true });
    }
    if (existsSync(rollbackSnapshotsPath)) {
      renameSync(rollbackSnapshotsPath, snapshotsPath);
    }
    if (databaseSwapped && existsSync(databasePath)) rmSync(databasePath);
    if (existsSync(rollbackPath)) {
      renameSync(rollbackPath, databasePath);
    }
    if (existsSync(tempPath)) rmSync(tempPath);
    if (existsSync(tempSnapshotsPath)) {
      rmSync(tempSnapshotsPath, { recursive: true, force: true });
    }
    getDatabase();
    throw error;
  }
  return {
    restoredAt: nowIso(),
    backupCreatedAt: payload.createdAt,
    snapshotCount: payload.snapshots.length,
    preRestoreBackup: preRestore.fileName,
  };
}

export function compactDatabase() {
  const database = getDatabase();
  database.exec("PRAGMA optimize");
  database.exec("VACUUM");
  return { compactedAt: nowIso(), databaseBytes: statSync(getDatabasePath()).size };
}

export function clearDemoData() {
  const database = getDatabase();
  const rows = database
    .query(
      `SELECT id FROM companies
       WHERE domain LIKE '%.example' OR website_url LIKE '%.example%'`,
    )
    .all() as Array<{ id: string }>;
  database.transaction(() => {
    for (const row of rows) {
      database
        .query(
          `DELETE FROM evidence
           WHERE entity_id = ?
              OR entity_id IN (SELECT id FROM contacts WHERE company_id = ?)
              OR entity_id IN (SELECT id FROM jobs WHERE company_id = ?)`,
        )
        .run(row.id, row.id, row.id);
      database.query("DELETE FROM companies WHERE id = ?").run(row.id);
      database.query("DELETE FROM company_search WHERE company_id = ?").run(row.id);
    }
  })();
  return { removedCompanies: rows.length };
}

export function deleteWorkingData() {
  const backup = createFullBackup();
  const database = getDatabase();
  database.transaction(() => {
    database.query("DELETE FROM evidence").run();
    database.query("DELETE FROM conflicts").run();
    database.query("DELETE FROM companies").run();
    database.query("DELETE FROM source_runs").run();
    database.query("DELETE FROM suppression_entries").run();
    database.query("DELETE FROM audit_events").run();
    database.query("DELETE FROM settings").run();
    database.query("DELETE FROM secrets").run();
    database.query("DELETE FROM company_search").run();
  })();
  const snapshots = getSnapshotsDir();
  if (path.dirname(snapshots) !== getDataDir()) {
    throw new Error("Resolved snapshots directory is unsafe.");
  }
  rmSync(snapshots, { recursive: true, force: true });
  ensurePrivateDirectory(snapshots);
  database.exec("VACUUM");
  return {
    deletedAt: nowIso(),
    recoveryBackup: backup.fileName,
  };
}

export function getLocalDataStatus() {
  const databasePath = getDatabasePath();
  const backups = listBackups();
  const counts = getDatabase()
    .query(
      `SELECT
        (SELECT COUNT(*) FROM companies) AS companies,
        (SELECT COUNT(*) FROM contacts) AS contacts,
        (SELECT COUNT(*) FROM jobs) AS jobs,
        (SELECT COUNT(*) FROM evidence) AS evidence`,
    )
    .get() as Record<string, number>;
  return {
    dataDirectory: getDataDir(),
    databasePath,
    databaseBytes: existsSync(databasePath) ? statSync(databasePath).size : 0,
    snapshotBytes: directorySize(getSnapshotsDir()),
    backupBytes: directorySize(backupsDir()),
    lastBackup: backups[0] || null,
    backups,
    counts: {
      companies: Number(counts.companies),
      contacts: Number(counts.contacts),
      jobs: Number(counts.jobs),
      evidence: Number(counts.evidence),
    },
    runtime: `Bun ${Bun.version}`,
    appVersion: "0.1.0",
  };
}

export function openDataDirectory() {
  const directory = getDataDir();
  const command =
    process.platform === "darwin"
      ? ["open", directory]
      : process.platform === "win32"
        ? ["explorer.exe", directory]
        : ["xdg-open", directory];
  const processHandle = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return { opened: true, directory, processId: processHandle.pid };
}
