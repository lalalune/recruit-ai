import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  openSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { APP_VERSION, SCHEMA_VERSION } from "../shared/version";
import {
  closeSqliteDatabase,
  closeDatabase,
  getDatabase,
  migrateDatabaseFile,
  newId,
  nowIso,
  readSchemaVersion,
  trackSqliteStatements,
} from "./database";
import {
  getDataDir,
  getDatabasePath,
  getSnapshotsDir,
  ensurePrivateDirectory,
} from "./paths";
import { addAudit, saveSetting } from "./repository";
import { badRequest, conflict, notFound } from "./errors";
import { withExclusiveDataOperation } from "./operationState";

const backupFormat = "recruitai-local-backup";
const backupVersion = 1;
const maxBackupTextBytes = 500 * 1024 * 1024;
const snapshotFilePattern = /^[a-f0-9]{64}\.html$/;
const restoreJournalFileName = ".restore-journal.json";

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

interface BackupCatalogMetadata {
  createdAt: string;
  snapshotCount: number;
}

interface SnapshotFile {
  path: string;
  filePath: string;
  bytes: number;
}

function backupsDir() {
  const value = path.join(getDataDir(), "backups");
  return ensurePrivateDirectory(value);
}

function backupMetadataPath(fileName: string) {
  return path.join(backupsDir(), `${fileName.slice(0, -".json".length)}.meta`);
}

function removeFileWithRetries(filePath: string) {
  rmSync(filePath, {
    force: true,
    recursive: true,
    maxRetries: 8,
    retryDelay: 50,
  });
}

function safeBackupPath(fileName: string) {
  const base = path.basename(fileName);
  if (base !== fileName || !/^recruitai-backup-[a-zA-Z0-9_.-]+\.json$/.test(base)) {
    throw badRequest("Invalid backup file name.");
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

function snapshotFiles(): SnapshotFile[] {
  const root = getSnapshotsDir();
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && snapshotFilePattern.test(entry.name),
    )
    .map((entry) => ({
      path: entry.name,
      filePath: path.join(root, entry.name),
      bytes: statSync(path.join(root, entry.name)).size,
    }));
}

function snapshotPayloads(files: readonly SnapshotFile[]): BackupSnapshot[] {
  return files.map((entry) => {
    const content = readFileSync(entry.filePath);
    const expectedName = `${createHash("sha256").update(content).digest("hex")}.html`;
    if (entry.path !== expectedName) {
      throw conflict(
        `Saved snapshot ${entry.path} failed its content-integrity check.`,
        "snapshot_integrity_failed",
      );
    }
    return {
      path: entry.path,
      contentBase64: content.toString("base64"),
    };
  });
}

function base64EncodedLength(bytes: number) {
  return Math.ceil(bytes / 3) * 4;
}

function formatMiB(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function assertBackupSizeBudget(
  createdAt: string,
  databaseBytes: number,
  files: readonly SnapshotFile[],
  requestedMaximum: number,
) {
  const maximum = Math.min(
    maxBackupTextBytes,
    Number.isFinite(requestedMaximum)
      ? Math.max(1, Math.floor(requestedMaximum))
      : maxBackupTextBytes,
  );
  const rawBytes =
    databaseBytes + files.reduce((total, file) => total + file.bytes, 0);
  const maximumPossibleRawBytes = Math.floor(maximum / 4) * 3;
  if (rawBytes > maximumPossibleRawBytes) {
    throw conflict(
      `Cannot create a restorable backup: ${formatMiB(rawBytes)} of raw database and snapshot data exceeds the ${formatMiB(maximum)} JSON backup budget.`,
      "backup_too_large",
    );
  }
  const emptyPayload: BackupPayload = {
    format: backupFormat,
    version: backupVersion,
    createdAt,
    appVersion: APP_VERSION,
    databaseBase64: "",
    snapshots: files.map((file) => ({
      path: file.path,
      contentBase64: "",
    })),
  };
  const encodedBytes =
    JSON.stringify(emptyPayload).length +
    base64EncodedLength(databaseBytes) +
    files.reduce(
      (total, file) => total + base64EncodedLength(file.bytes),
      0,
    );
  if (encodedBytes > maximum) {
    throw conflict(
      `Cannot create a restorable backup: the encoded JSON would be ${formatMiB(encodedBytes)}, above the ${formatMiB(maximum)} local restore limit.`,
      "backup_too_large",
    );
  }
  return maximum;
}

function checkpointDatabase() {
  getDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

function publishBackupFiles(
  filePath: string,
  metadataPath: string,
  serializedBackup: string,
  serializedMetadata: string,
) {
  const directory = path.dirname(filePath);
  const operationId = newId();
  const temporaryBackupPath = path.join(
    directory,
    `.backup-${operationId}.json.tmp`,
  );
  const temporaryMetadataPath = path.join(
    directory,
    `.backup-${operationId}.meta.tmp`,
  );
  let metadataPublished = false;
  let backupPublished = false;
  try {
    if (existsSync(filePath) || existsSync(metadataPath)) {
      throw conflict(
        "A backup with the generated name already exists. Try again.",
        "backup_name_collision",
      );
    }
    writeFileSync(temporaryBackupPath, serializedBackup, {
      encoding: "utf8",
      mode: 0o600,
    });
    syncPath(temporaryBackupPath);
    writeFileSync(temporaryMetadataPath, serializedMetadata, {
      encoding: "utf8",
      mode: 0o600,
    });
    syncPath(temporaryMetadataPath);

    // Metadata is installed first. The complete JSON rename is the publication
    // marker because listBackups only exposes final *.json names.
    renameSync(temporaryMetadataPath, metadataPath);
    metadataPublished = true;
    syncDirectory(directory);
    renameSync(temporaryBackupPath, filePath);
    backupPublished = true;
    syncDirectory(directory);
  } catch (error) {
    if (metadataPublished && !backupPublished) {
      removeFileWithRetries(metadataPath);
      syncDirectory(directory);
    }
    throw error;
  } finally {
    removeFileWithRetries(temporaryBackupPath);
    removeFileWithRetries(temporaryMetadataPath);
  }
}

function createFullBackupUnsafe(
  maximumTextBytes: number = maxBackupTextBytes,
) {
  checkpointDatabase();
  const createdAt = nowIso();
  const safeTimestamp = createdAt.replace(/[:]/g, "-");
  const fileName =
    `recruitai-backup-${safeTimestamp}-${newId().slice(0, 8)}.json`;
  const files = snapshotFiles();
  const databaseSize = statSync(getDatabasePath()).size;
  const effectiveMaximum = assertBackupSizeBudget(
    createdAt,
    databaseSize,
    files,
    maximumTextBytes,
  );
  const snapshots = snapshotPayloads(files);
  const snapshotNames = new Set(snapshots.map((snapshot) => snapshot.path));
  const snapshotReferences = getDatabase()
    .query(
      `SELECT screenshot_path FROM evidence
       WHERE screenshot_path IS NOT NULL AND screenshot_path != ''`,
    )
    .all() as Array<{ screenshot_path: string }>;
  for (const reference of snapshotReferences) {
    const fileName = snapshotBaseName(reference.screenshot_path);
    if (!snapshotFilePattern.test(fileName) || !snapshotNames.has(fileName)) {
      throw conflict(
        "A saved evidence snapshot is missing or corrupt. Repair it before creating a backup.",
        "snapshot_reference_invalid",
      );
    }
  }
  const databaseContent = readFileSync(getDatabasePath());
  const payload: BackupPayload = {
    format: backupFormat,
    version: backupVersion,
    createdAt,
    appVersion: APP_VERSION,
    databaseBase64: databaseContent.toString("base64"),
    snapshots,
  };
  const serialized = JSON.stringify(payload);
  const actualRawBytes =
    databaseContent.length +
    snapshots.reduce(
      (total, snapshot) =>
        total + Buffer.byteLength(snapshot.contentBase64, "base64"),
      0,
    );
  if (
    actualRawBytes > Math.floor(effectiveMaximum / 4) * 3 ||
    Buffer.byteLength(serialized, "utf8") > effectiveMaximum
  ) {
    throw conflict(
      `Cannot create a restorable backup: local data changed while the backup was prepared and now exceeds the ${formatMiB(effectiveMaximum)} local restore limit.`,
      "backup_too_large",
    );
  }
  const filePath = safeBackupPath(fileName);
  const metadataPath = backupMetadataPath(fileName);
  publishBackupFiles(
    filePath,
    metadataPath,
    serialized,
    JSON.stringify({
      createdAt,
      snapshotCount: payload.snapshots.length,
    } satisfies BackupCatalogMetadata),
  );
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

export function createFullBackup(
  maximumTextBytes: number = maxBackupTextBytes,
) {
  return withExclusiveDataOperation("create a local backup", () => {
    assertNoActiveResearch("create a local backup");
    return createFullBackupUnsafe(maximumTextBytes);
  });
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
      let metadata: BackupCatalogMetadata | null = null;
      try {
        const candidate = JSON.parse(
          readFileSync(backupMetadataPath(entry.name), "utf8"),
        ) as Partial<BackupCatalogMetadata>;
        if (
          typeof candidate.createdAt === "string" &&
          Number.isFinite(Date.parse(candidate.createdAt)) &&
          Number.isInteger(candidate.snapshotCount) &&
          Number(candidate.snapshotCount) >= 0
        ) {
          metadata = candidate as BackupCatalogMetadata;
        }
      } catch {
        // Backups created before catalog metadata remain downloadable.
      }
      return {
        fileName: entry.name,
        bytes: stat.size,
        createdAt: metadata?.createdAt || stat.mtime.toISOString(),
        snapshotCount: metadata?.snapshotCount ?? null,
        downloadUrl: `/api/data/backups/${encodeURIComponent(entry.name)}`,
      };
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function getBackupFile(fileName: string) {
  const filePath = safeBackupPath(fileName);
  if (!existsSync(filePath)) throw notFound("Backup not found.");
  return { filePath, fileName: path.basename(filePath) };
}

function parseBackup(backupText: string): BackupPayload {
  if (Buffer.byteLength(backupText, "utf8") > maxBackupTextBytes) {
    throw badRequest("Backup exceeds the 500 MB local restore limit.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(backupText);
  } catch {
    throw badRequest("The selected file is not valid JSON backup data.");
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
    throw badRequest("This is not a compatible RecruitAI backup.");
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
      throw badRequest("The backup contains an unsafe snapshot path.");
    }
    snapshotNames.add(snapshot.path);
  }
  return candidate as BackupPayload;
}

function decodeBase64(value: string, label: string) {
  if (!/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(value)) {
    throw badRequest(`${label} contains invalid base64 data.`);
  }
  return Buffer.from(value, "base64");
}

function decodeSnapshot(snapshot: BackupSnapshot) {
  const content = decodeBase64(snapshot.contentBase64, `Snapshot ${snapshot.path}`);
  const expectedName = `${createHash("sha256").update(content).digest("hex")}.html`;
  if (snapshot.path !== expectedName) {
    throw badRequest(
      `Snapshot ${snapshot.path} failed its content-integrity check.`,
    );
  }
  return content;
}

function snapshotBaseName(value: string) {
  return value.replaceAll("\\", "/").split("/").pop() || "";
}

const requiredTables = [
  "schema_migrations",
  "companies",
  "company_aliases",
  "contacts",
  "jobs",
  "evidence",
  "conflicts",
  "source_runs",
  "reviews",
  "outreach_drafts",
  "suppression_entries",
  "audit_events",
  "settings",
  "secrets",
  "company_search",
] as const;

const legacyRequiredColumns: Record<(typeof requiredTables)[number], string[]> = {
  schema_migrations: ["version", "applied_at"],
  companies: [
    "id", "name", "normalized_name", "domain", "website_url", "linkedin_url",
    "yc_url", "description", "location", "employee_count_min",
    "employee_count_max", "industries_json", "stage", "status", "priority",
    "notes", "reviewed", "hiring_score", "open_roles_count",
    "fresh_roles_count", "conflict_count", "last_researched_at", "created_at",
    "updated_at",
  ],
  company_aliases: [
    "id", "company_id", "alias", "normalized_alias", "source_type",
  ],
  contacts: [
    "id", "company_id", "first_name", "last_name", "full_name", "title",
    "role_category", "email", "email_type", "email_status",
    "email_verified_at", "phone", "phone_type", "linkedin_url", "rank", "status",
    "reviewed", "notes", "created_at", "updated_at",
  ],
  jobs: [
    "id", "company_id", "external_id", "title", "location", "department",
    "description_excerpt", "url", "source_type", "posted_at", "first_seen_at",
    "last_seen_at", "active",
  ],
  evidence: [
    "id", "entity_type", "entity_id", "field_name", "value", "source_type",
    "source_label", "source_url", "excerpt", "screenshot_path", "confidence",
    "captured_at", "payload_json",
  ],
  conflicts: [
    "id", "company_id", "entity_type", "entity_id", "field_name",
    "current_value", "candidate_value", "evidence_id", "status", "resolution",
    "resolution_note", "created_at", "resolved_at",
  ],
  source_runs: [
    "id", "source_type", "status", "params_json", "inserted_count",
    "updated_count", "skipped_count", "error_message", "created_at",
    "started_at", "finished_at",
  ],
  reviews: ["id", "company_id", "decision", "notes", "created_at"],
  outreach_drafts: [
    "id", "company_id", "contact_id", "subject", "body", "status",
    "scheduled_at", "sent_at", "gmail_message_id", "gmail_thread_id",
    "created_at", "updated_at",
  ],
  suppression_entries: ["id", "value", "kind", "reason", "created_at"],
  audit_events: [
    "id", "event_type", "entity_type", "entity_id", "summary", "payload_json",
    "created_at",
  ],
  settings: ["key", "value_json", "updated_at"],
  secrets: ["key", "value", "updated_at"],
  company_search: ["company_id", "name", "domain", "description", "industries"],
};

const currentOnlyColumns: Partial<
  Record<(typeof requiredTables)[number], string[]>
> = {
  companies: [
    "fit_confirmed", "recruiting_fit", "recruiting_fit_note",
    "exclusion_reason", "exclusion_note", "hiring_score_json",
  ],
  contacts: [
    "fallback_reason", "fallback_confirmed", "phone_confirmed", "phone_source",
    "employment_confirmed", "observed_title", "employment_observed_at",
  ],
  jobs: ["confirmed_live", "observed_at"],
  source_runs: ["params_hash"],
  outreach_drafts: ["edited_at", "outcome_at", "outcome_note"],
};

function validateSqliteFile(
  filePath: string,
  expectedSnapshots?: ReadonlySet<string>,
  shape: "legacy" | "current" = "current",
) {
  // A checkpointed SQLite database can still declare WAL journal mode in its
  // header. SQLite may need to create transient sidecars before a read-only
  // query can start, so open the already-created temp file read/write, then
  // immediately put the connection in query-only/untrusted-schema mode.
  const candidate = trackSqliteStatements(
    new Database(filePath, { readwrite: true, create: false }),
  );
  try {
    candidate.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    const tablePlaceholders = requiredTables.map(() => "?").join(", ");
    const tables = candidate
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (${tablePlaceholders})`,
      )
      .all(...requiredTables) as Array<{ name: string }>;
    if (tables.length !== requiredTables.length) {
      throw badRequest("Backup database is missing required RecruitAI tables.");
    }
    const version = readSchemaVersion(candidate);
    if (version > SCHEMA_VERSION) {
      throw conflict(
        `Backup schema version ${version} is newer than the supported version ${SCHEMA_VERSION}.`,
        "newer_backup_schema",
      );
    }
    if (shape === "current" && version !== SCHEMA_VERSION) {
      throw badRequest("Backup database was not migrated to the current schema.");
    }
    for (const table of requiredTables) {
      const expected = [
        ...legacyRequiredColumns[table],
        ...(shape === "current" ? currentOnlyColumns[table] || [] : []),
      ];
      const columns = new Set(
        (
          candidate.query(`PRAGMA table_info('${table}')`).all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      if (expected.some((column) => !columns.has(column))) {
        throw badRequest(
          `Backup database has an incompatible ${table} table.`,
        );
      }
    }
    const integrity = candidate.query("PRAGMA integrity_check").get() as
      | { integrity_check: string }
      | null;
    if (integrity?.integrity_check !== "ok") {
      throw badRequest("Backup database failed SQLite integrity validation.");
    }
    const foreignKeyErrors = candidate.query("PRAGMA foreign_key_check").all();
    if (foreignKeyErrors.length > 0) {
      throw badRequest("Backup database contains broken record references.");
    }
    const snapshotReferences = candidate
      .query(
        `SELECT screenshot_path FROM evidence
         WHERE screenshot_path IS NOT NULL AND screenshot_path != ''`,
      )
      .all() as Array<{ screenshot_path: string }>;
    for (const reference of snapshotReferences) {
      const fileName = snapshotBaseName(reference.screenshot_path);
      if (
        !snapshotFilePattern.test(fileName) ||
        (expectedSnapshots && !expectedSnapshots.has(fileName))
      ) {
        throw badRequest(
          "Backup database contains a missing or unsafe snapshot reference.",
        );
      }
    }
  } finally {
    try {
      candidate.exec("PRAGMA query_only = OFF");
    } catch {
      // Continue closing an invalid or already-failed candidate.
    }
    closeSqliteDatabase(candidate);
    removeFileWithRetries(`${filePath}-wal`);
    removeFileWithRetries(`${filePath}-shm`);
  }
}

export function inspectBackup(backupText: string) {
  const payload = parseBackup(backupText);
  const databaseBytes = decodeBase64(payload.databaseBase64, "Backup database");
  if (databaseBytes.length < 100) {
    throw badRequest("Backup database is empty or corrupt.");
  }
  for (const snapshot of payload.snapshots) {
    decodeSnapshot(snapshot);
  }
  const tempPath = path.join(getDataDir(), `.inspect-${newId()}.sqlite`);
  writeFileSync(tempPath, databaseBytes, { mode: 0o600 });
  try {
    validateSqliteFile(
      tempPath,
      new Set(payload.snapshots.map((snapshot) => snapshot.path)),
      "legacy",
    );
    migrateDatabaseFile(tempPath);
    validateSqliteFile(
      tempPath,
      new Set(payload.snapshots.map((snapshot) => snapshot.path)),
      "current",
    );
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

function rewriteSnapshotReferences(
  databasePath: string,
  snapshotNames: ReadonlySet<string>,
  destinationDirectory: string,
) {
  const database = trackSqliteStatements(
    new Database(databasePath, { readwrite: true, create: false }),
  );
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
    const references = database
      .query(
        `SELECT id, screenshot_path FROM evidence
         WHERE screenshot_path IS NOT NULL AND screenshot_path != ''`,
      )
      .all() as Array<{ id: string; screenshot_path: string }>;
    database.transaction(() => {
      for (const reference of references) {
        const fileName = snapshotBaseName(reference.screenshot_path);
        if (
          !snapshotFilePattern.test(fileName) ||
          !snapshotNames.has(fileName)
        ) {
          throw badRequest(
            "Backup database contains a missing or unsafe snapshot reference.",
          );
        }
        database
          .query("UPDATE evidence SET screenshot_path = ? WHERE id = ?")
          .run(path.join(destinationDirectory, fileName), reference.id);
      }
    })();
  } finally {
    closeSqliteDatabase(database);
  }
}

type RestorePhase =
  | "prepared"
  | "old_database_moved"
  | "new_database_installed"
  | "old_snapshots_moved"
  | "new_snapshots_installed"
  | "committed";

interface RestoreJournal {
  version: 1;
  restoreId: string;
  phase: RestorePhase;
  createdAt: string;
  snapshotNames: string[];
}

function restorePaths(restoreId: string) {
  if (!/^[a-f0-9-]{36}$/i.test(restoreId)) {
    throw new Error("The restore journal contains an invalid operation ID.");
  }
  const dataDirectory = getDataDir();
  return {
    dataDirectory,
    journalPath: path.join(dataDirectory, restoreJournalFileName),
    databasePath: path.join(dataDirectory, "recruit-ai.sqlite"),
    snapshotsPath: path.join(dataDirectory, "snapshots"),
    tempPath: path.join(dataDirectory, `.restore-${restoreId}.sqlite`),
    rollbackPath: path.join(dataDirectory, `.rollback-${restoreId}.sqlite`),
    tempSnapshotsPath: path.join(
      dataDirectory,
      `.restore-snapshots-${restoreId}`,
    ),
    rollbackSnapshotsPath: path.join(
      dataDirectory,
      `.rollback-snapshots-${restoreId}`,
    ),
  };
}

function syncPath(filePath: string) {
  // Windows FlushFileBuffers requires a writable file handle. The files
  // passed here are app-owned database, journal, snapshot, and backup files.
  const descriptor = openSync(
    filePath,
    process.platform === "win32" ? "r+" : "r",
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(directory: string) {
  try {
    syncPath(directory);
  } catch (error) {
    // Windows does not consistently permit fsync on directory handles.
    if (process.platform !== "win32") throw error;
  }
}

function writeRestoreJournal(journal: RestoreJournal) {
  const paths = restorePaths(journal.restoreId);
  const temporaryJournal = path.join(
    paths.dataDirectory,
    `.restore-journal-${journal.restoreId}.tmp`,
  );
  writeFileSync(temporaryJournal, `${JSON.stringify(journal)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  syncPath(temporaryJournal);
  renameSync(temporaryJournal, paths.journalPath);
  syncDirectory(paths.dataDirectory);
}

function removeRestoreJournal(journalPath: string, dataDirectory: string) {
  rmSync(journalPath, { force: true });
  syncDirectory(dataDirectory);
}

function readRestoreJournal(): RestoreJournal | null {
  const journalPath = path.join(getDataDir(), restoreJournalFileName);
  if (!existsSync(journalPath)) return null;
  let value: Partial<RestoreJournal>;
  try {
    value = JSON.parse(readFileSync(journalPath, "utf8")) as Partial<RestoreJournal>;
  } catch {
    throw new Error(
      `RecruitAI found an unreadable restore journal at ${journalPath}. Preserve the data directory and recover it manually before starting.`,
    );
  }
  const phases: RestorePhase[] = [
    "prepared",
    "old_database_moved",
    "new_database_installed",
    "old_snapshots_moved",
    "new_snapshots_installed",
    "committed",
  ];
  if (
    value.version !== 1 ||
    typeof value.restoreId !== "string" ||
    !phases.includes(value.phase as RestorePhase) ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.snapshotNames) ||
    value.snapshotNames.some(
      (name) => typeof name !== "string" || !snapshotFilePattern.test(name),
    )
  ) {
    throw new Error(
      `RecruitAI found an invalid restore journal at ${journalPath}. Preserve the data directory and recover it manually before starting.`,
    );
  }
  return value as RestoreJournal;
}

function removeRestoreArtifacts(paths: ReturnType<typeof restorePaths>) {
  removeFileWithRetries(paths.tempPath);
  removeFileWithRetries(`${paths.tempPath}-wal`);
  removeFileWithRetries(`${paths.tempPath}-shm`);
  removeFileWithRetries(paths.tempSnapshotsPath);
}

function verifyInstalledSnapshots(
  snapshotsPath: string,
  snapshotNames: readonly string[],
) {
  if (!existsSync(snapshotsPath)) {
    throw new Error("The committed restore is missing its snapshots directory.");
  }
  for (const snapshotName of snapshotNames) {
    const snapshotPath = path.join(snapshotsPath, snapshotName);
    if (!existsSync(snapshotPath)) {
      throw new Error(
        `The committed restore is missing snapshot ${snapshotName}.`,
      );
    }
    const content = readFileSync(snapshotPath);
    const expectedName = `${createHash("sha256").update(content).digest("hex")}.html`;
    if (expectedName !== snapshotName) {
      throw new Error(
        `The committed restore snapshot ${snapshotName} failed its integrity check.`,
      );
    }
  }
}

function validateRestoreGeneration(
  databasePath: string,
  snapshotsPath: string,
  snapshotNames: readonly string[],
) {
  if (!existsSync(databasePath)) {
    throw new Error("The restore generation is missing its database.");
  }
  verifyInstalledSnapshots(snapshotsPath, snapshotNames);
  validateSqliteFile(databasePath, new Set(snapshotNames), "current");
}

function verifiedSnapshotNames(snapshotsPath: string) {
  if (!existsSync(snapshotsPath)) {
    throw new Error("The restore generation is missing its snapshots directory.");
  }
  const names = readdirSync(snapshotsPath, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && snapshotFilePattern.test(entry.name),
    )
    .map((entry) => entry.name);
  verifyInstalledSnapshots(snapshotsPath, names);
  return names;
}

export function recoverInterruptedRestore() {
  const journal = readRestoreJournal();
  if (!journal) return { recovered: false, phase: null };
  const paths = restorePaths(journal.restoreId);
  closeDatabase();
  if (journal.phase === "committed") {
    try {
      validateRestoreGeneration(
        paths.databasePath,
        paths.snapshotsPath,
        journal.snapshotNames,
      );
    } catch (installedError) {
      if (
        !existsSync(paths.rollbackPath) ||
        !existsSync(paths.rollbackSnapshotsPath)
      ) {
        throw new AggregateError(
          [installedError],
          "The committed restore failed integrity validation and no complete rollback generation remains. Preserve the local data directory for manual recovery.",
        );
      }
      try {
        const rollbackSnapshotNames = verifiedSnapshotNames(
          paths.rollbackSnapshotsPath,
        );
        validateRestoreGeneration(
          paths.rollbackPath,
          paths.rollbackSnapshotsPath,
          rollbackSnapshotNames,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [installedError, rollbackError],
          "Both the committed restore and its rollback generation failed integrity validation. Preserve the local data directory for manual recovery.",
        );
      }
      removeFileWithRetries(paths.databasePath);
      removeFileWithRetries(`${paths.databasePath}-wal`);
      removeFileWithRetries(`${paths.databasePath}-shm`);
      removeFileWithRetries(paths.snapshotsPath);
      renameSync(paths.rollbackPath, paths.databasePath);
      renameSync(paths.rollbackSnapshotsPath, paths.snapshotsPath);
      syncDirectory(paths.dataDirectory);
      removeRestoreArtifacts(paths);
      removeRestoreJournal(paths.journalPath, paths.dataDirectory);
      return { recovered: true, phase: "rolled_back" as const };
    }
    removeFileWithRetries(paths.rollbackPath);
    removeFileWithRetries(paths.rollbackSnapshotsPath);
    removeRestoreArtifacts(paths);
    removeRestoreJournal(paths.journalPath, paths.dataDirectory);
    return { recovered: true, phase: "committed" as const };
  }

  // Any rollback artifact is authoritative until the committed phase has been
  // durably journaled. This also covers a crash between a rename and its next
  // journal update.
  if (existsSync(paths.rollbackPath)) {
    removeFileWithRetries(paths.databasePath);
    removeFileWithRetries(`${paths.databasePath}-wal`);
    removeFileWithRetries(`${paths.databasePath}-shm`);
    renameSync(paths.rollbackPath, paths.databasePath);
  } else if (!existsSync(paths.databasePath)) {
    throw new Error(
      "An interrupted restore has neither the prior nor installed database. Preserve the data directory for manual recovery.",
    );
  }
  if (existsSync(paths.rollbackSnapshotsPath)) {
    removeFileWithRetries(paths.snapshotsPath);
    renameSync(paths.rollbackSnapshotsPath, paths.snapshotsPath);
  } else if (!existsSync(paths.snapshotsPath)) {
    throw new Error(
      "An interrupted restore has neither the prior nor installed snapshots directory. Preserve the data directory for manual recovery.",
    );
  }
  removeRestoreArtifacts(paths);
  removeRestoreJournal(paths.journalPath, paths.dataDirectory);
  return { recovered: true, phase: "rolled_back" as const };
}

export function restoreFullBackup(backupText: string) {
  return withExclusiveDataOperation("restore local data", () => {
    assertNoActiveResearch("restore local data");
    const payload = parseBackup(backupText);
    const databaseBytes = decodeBase64(payload.databaseBase64, "Backup database");
    if (databaseBytes.length < 100) {
      throw badRequest("Backup database is empty or corrupt.");
    }
    const restoreId = newId();
    const paths = restorePaths(restoreId);
    if (existsSync(paths.journalPath)) {
      throw conflict(
        "An earlier restore requires recovery before another restore can start.",
        "restore_recovery_required",
      );
    }
    const snapshotNames = new Set(
      payload.snapshots.map((snapshot) => snapshot.path),
    );
    writeFileSync(paths.tempPath, databaseBytes, { mode: 0o600 });
    mkdirSync(paths.tempSnapshotsPath, { recursive: false, mode: 0o700 });
    try {
      validateSqliteFile(paths.tempPath, snapshotNames, "legacy");
      migrateDatabaseFile(paths.tempPath);
      rewriteSnapshotReferences(
        paths.tempPath,
        snapshotNames,
        paths.snapshotsPath,
      );
      validateSqliteFile(paths.tempPath, snapshotNames, "current");
      syncPath(paths.tempPath);
      for (const snapshot of payload.snapshots) {
        const snapshotPath = path.join(paths.tempSnapshotsPath, snapshot.path);
        writeFileSync(snapshotPath, decodeSnapshot(snapshot), { mode: 0o600 });
        syncPath(snapshotPath);
      }
      syncDirectory(paths.tempSnapshotsPath);
    } catch (error) {
      removeRestoreArtifacts(paths);
      throw error;
    }

    const preRestore = createFullBackupUnsafe();
    const journal: RestoreJournal = {
      version: 1,
      restoreId,
      phase: "prepared",
      createdAt: nowIso(),
      snapshotNames: [...snapshotNames],
    };
    let journalWritten = false;
    let committed = false;
    let cleanupPending = false;
    try {
      writeRestoreJournal(journal);
      journalWritten = true;
      closeDatabase();
      removeFileWithRetries(`${paths.databasePath}-wal`);
      removeFileWithRetries(`${paths.databasePath}-shm`);
      renameSync(paths.databasePath, paths.rollbackPath);
      journal.phase = "old_database_moved";
      writeRestoreJournal(journal);

      renameSync(paths.tempPath, paths.databasePath);
      if (process.platform !== "win32") chmodSync(paths.databasePath, 0o600);
      journal.phase = "new_database_installed";
      writeRestoreJournal(journal);

      renameSync(paths.snapshotsPath, paths.rollbackSnapshotsPath);
      journal.phase = "old_snapshots_moved";
      writeRestoreJournal(journal);

      renameSync(paths.tempSnapshotsPath, paths.snapshotsPath);
      journal.phase = "new_snapshots_installed";
      writeRestoreJournal(journal);

      const restoredDatabase = getDatabase();
      const potentiallyReplayedDrafts = restoredDatabase
        .query(
          `SELECT id, company_id, status FROM outreach_drafts
           WHERE status IN ('draft', 'approved', 'sending')`,
        )
        .all() as Array<{ id: string; company_id: string; status: string }>;
      restoredDatabase
        .query(
          `UPDATE outreach_drafts
           SET status = 'send_unknown', updated_at = ?
           WHERE status IN ('draft', 'approved', 'sending')`,
        )
        .run(nowIso());
      saveSetting("gmail_sending_enabled", false);
      saveSetting("gmail_test_passed_at", null);
      for (const draft of potentiallyReplayedDrafts) {
        addAudit(
          "outreach.restore_reconciliation_required",
          "company",
          draft.company_id,
          "Backup restore requires Gmail Sent-mail reconciliation before outreach can continue",
          { draftId: draft.id, restoredStatus: draft.status },
        );
      }
      restoredDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      closeDatabase();
      if (existsSync(paths.databasePath)) syncPath(paths.databasePath);
      validateRestoreGeneration(
        paths.databasePath,
        paths.snapshotsPath,
        journal.snapshotNames,
      );
      journal.phase = "committed";
      writeRestoreJournal(journal);
      committed = true;
    } catch (error) {
      if (!committed) {
        closeDatabase();
        try {
          if (journalWritten) recoverInterruptedRestore();
          else removeRestoreArtifacts(paths);
          getDatabase();
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "The restore failed and automatic rollback also failed. Preserve the local data directory for manual recovery.",
          );
        }
      }
      throw error;
    }

    try {
      removeFileWithRetries(paths.rollbackPath);
      removeFileWithRetries(paths.rollbackSnapshotsPath);
      removeRestoreArtifacts(paths);
      removeRestoreJournal(paths.journalPath, paths.dataDirectory);
    } catch {
      // The committed journal makes this cleanup idempotent at next startup.
      cleanupPending = true;
    }
    return {
      restoredAt: nowIso(),
      backupCreatedAt: payload.createdAt,
      snapshotCount: payload.snapshots.length,
      preRestoreBackup: preRestore.fileName,
      cleanupPending,
    };
  });
}

export function compactDatabase() {
  return withExclusiveDataOperation("compact the database", () => {
    assertNoActiveResearch("compact the database");
    const database = getDatabase();
    database.exec("PRAGMA optimize");
    database.exec("VACUUM");
    return {
      compactedAt: nowIso(),
      databaseBytes: statSync(getDatabasePath()).size,
    };
  });
}

function safeSnapshotFilePath(value: string) {
  const snapshotsRoot = path.resolve(getSnapshotsDir());
  const candidate = path.resolve(value);
  const fileName = path.basename(candidate);
  return path.dirname(candidate) === snapshotsRoot &&
    snapshotFilePattern.test(fileName)
    ? candidate
    : null;
}

function removeUnreferencedSnapshots(candidates: ReadonlySet<string>) {
  if (!candidates.size) return 0;
  const referenced = new Set(
    (
      getDatabase()
        .query(
          `SELECT screenshot_path FROM evidence
           WHERE screenshot_path IS NOT NULL AND screenshot_path != ''`,
        )
        .all() as Array<{ screenshot_path: string }>
    )
      .map((row) => safeSnapshotFilePath(row.screenshot_path))
      .filter((filePath): filePath is string => Boolean(filePath)),
  );
  let removed = 0;
  for (const value of candidates) {
    const filePath = safeSnapshotFilePath(value);
    if (!filePath || referenced.has(filePath) || !existsSync(filePath)) continue;
    if (!statSync(filePath).isFile()) continue;
    removeFileWithRetries(filePath);
    removed++;
  }
  return removed;
}

export function clearDemoData() {
  return withExclusiveDataOperation("clear demo data", () => {
    assertNoActiveResearch("clear demo data");
    const database = getDatabase();
    const candidates = database
      .query(
        `SELECT id, domain, website_url FROM companies`,
      )
      .all() as Array<{
        id: string;
        domain: string | null;
        website_url: string | null;
      }>;
    const rows = candidates.filter((row) => {
      const domain = row.domain?.trim().toLowerCase() || "";
      if (domain.endsWith(".example")) return true;
      if (!row.website_url) return false;
      try {
        return new URL(row.website_url).hostname
          .replace(/\.$/, "")
          .toLowerCase()
          .endsWith(".example");
      } catch {
        return false;
      }
    });
    const recoveryBackup = rows.length ? createFullBackupUnsafe() : null;
    const snapshotCandidates = new Set<string>();
    const evidenceIds = new Set<string>();
    const relatedEntityIds = new Set(rows.map((row) => row.id));
    for (const row of rows) {
      for (const table of [
        "company_aliases",
        "contacts",
        "jobs",
        "conflicts",
        "reviews",
        "outreach_drafts",
      ] as const) {
        const related = database
          .query(`SELECT id FROM ${table} WHERE company_id = ?`)
          .all(row.id) as Array<{ id: string }>;
        for (const item of related) relatedEntityIds.add(item.id);
      }
    }
    for (const entityId of [...relatedEntityIds]) {
      const evidenceRows = database
        .query(
          `SELECT id, screenshot_path FROM evidence
           WHERE entity_id = ?`,
        )
        .all(entityId) as Array<{
          id: string;
          screenshot_path: string | null;
        }>;
      for (const evidence of evidenceRows) {
        evidenceIds.add(evidence.id);
        relatedEntityIds.add(evidence.id);
        if (evidence.screenshot_path) {
          snapshotCandidates.add(evidence.screenshot_path);
        }
      }
    }
    let removedAuditEvents = 0;
    database.transaction(() => {
      for (const entityId of relatedEntityIds) {
        removedAuditEvents += database
          .query("DELETE FROM audit_events WHERE entity_id = ?")
          .run(entityId).changes;
      }
      for (const evidenceId of evidenceIds) {
        database.query("DELETE FROM evidence WHERE id = ?").run(evidenceId);
      }
      for (const row of rows) {
        database.query("DELETE FROM companies WHERE id = ?").run(row.id);
        database
          .query("DELETE FROM company_search WHERE company_id = ?")
          .run(row.id);
      }
    })();
    const removedSnapshots = removeUnreferencedSnapshots(snapshotCandidates);
    return {
      removedCompanies: rows.length,
      removedAuditEvents,
      removedSnapshots,
      recoveryBackup: recoveryBackup?.fileName ?? null,
    };
  });
}

export function deleteWorkingData() {
  return withExclusiveDataOperation("delete local data", () => {
    assertNoActiveResearch("delete local data");
    const backup = createFullBackupUnsafe();
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
  });
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
    appVersion: APP_VERSION,
  };
}

function assertNoActiveResearch(action: string) {
  const row = getDatabase()
    .query(
      `SELECT COUNT(*) AS count FROM source_runs
       WHERE status IN ('queued', 'running')`,
    )
    .get() as { count: number };
  if (Number(row.count) > 0) {
    throw conflict(
      `Wait for active research runs to finish before you ${action}.`,
      "active_research",
    );
  }
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
