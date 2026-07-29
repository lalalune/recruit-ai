import { Database, constants } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { SCHEMA_VERSION } from "../shared/version";
import { getDatabasePath } from "./paths";

let singleton: Database | null = null;
type FinalizableStatement = { finalize(): void };
const trackedStatements = new WeakMap<Database, Set<FinalizableStatement>>();

export function trackSqliteStatements(database: Database) {
  if (trackedStatements.has(database)) return database;
  const statements = new Set<FinalizableStatement>();
  const originalQuery = database.query.bind(database) as (
    sql: string,
  ) => FinalizableStatement;
  const originalPrepare = database.prepare.bind(database) as (
    sql: string,
    ...bindings: unknown[]
  ) => FinalizableStatement;
  Object.defineProperty(database, "query", {
    configurable: true,
    value: (sql: string) => {
      const statement = originalQuery(sql);
      statements.add(statement);
      return statement;
    },
  });
  Object.defineProperty(database, "prepare", {
    configurable: true,
    value: (sql: string, ...bindings: unknown[]) => {
      const statement = originalPrepare(sql, ...bindings);
      statements.add(statement);
      return statement;
    },
  });
  trackedStatements.set(database, statements);
  return database;
}

const schema = `
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  domain TEXT,
  website_url TEXT,
  linkedin_url TEXT,
  yc_url TEXT,
  description TEXT,
  location TEXT,
  employee_count_min INTEGER,
  employee_count_max INTEGER,
  industries_json TEXT NOT NULL DEFAULT '[]',
  stage TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'medium',
  fit_confirmed INTEGER NOT NULL DEFAULT 0,
  recruiting_fit TEXT NOT NULL DEFAULT 'unknown',
  recruiting_fit_note TEXT,
  exclusion_reason TEXT,
  exclusion_note TEXT,
  notes TEXT,
  reviewed INTEGER NOT NULL DEFAULT 0,
  hiring_score REAL NOT NULL DEFAULT 0,
  hiring_score_json TEXT NOT NULL DEFAULT '{}',
  open_roles_count INTEGER NOT NULL DEFAULT 0,
  fresh_roles_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  last_researched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS companies_domain_unique
  ON companies(domain) WHERE domain IS NOT NULL AND domain != '';
CREATE INDEX IF NOT EXISTS companies_status_idx ON companies(status);
CREATE INDEX IF NOT EXISTS companies_reviewed_idx ON companies(reviewed);
CREATE INDEX IF NOT EXISTS companies_hiring_idx ON companies(hiring_score DESC);
CREATE INDEX IF NOT EXISTS companies_normalized_name_idx ON companies(normalized_name);

CREATE TABLE IF NOT EXISTS company_aliases (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source_type TEXT NOT NULL,
  UNIQUE(company_id, normalized_alias)
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  first_name TEXT,
  last_name TEXT,
  full_name TEXT NOT NULL,
  title TEXT,
  role_category TEXT,
  email TEXT,
  email_type TEXT NOT NULL DEFAULT 'unknown',
  fallback_reason TEXT,
  fallback_confirmed INTEGER NOT NULL DEFAULT 0,
  email_status TEXT NOT NULL DEFAULT 'unverified',
  email_verified_at TEXT,
  phone TEXT,
  phone_type TEXT NOT NULL DEFAULT 'unknown',
  phone_confirmed INTEGER NOT NULL DEFAULT 0,
  phone_source TEXT,
  linkedin_url TEXT,
  employment_confirmed INTEGER NOT NULL DEFAULT 0,
  observed_title TEXT,
  employment_observed_at TEXT,
  rank INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'candidate',
  reviewed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS contacts_company_idx ON contacts(company_id, rank);
CREATE INDEX IF NOT EXISTS contacts_email_idx ON contacts(email);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_email_unique
  ON contacts(company_id, email) WHERE email IS NOT NULL AND email != '';

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_id TEXT,
  title TEXT NOT NULL,
  location TEXT,
  department TEXT,
  description_excerpt TEXT,
  url TEXT,
  source_type TEXT NOT NULL,
  posted_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  confirmed_live INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT,
  UNIQUE(company_id, source_type, external_id)
);

CREATE INDEX IF NOT EXISTS jobs_company_idx ON jobs(company_id, active);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  value TEXT,
  source_type TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_url TEXT,
  excerpt TEXT,
  screenshot_path TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  captured_at TEXT NOT NULL,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS evidence_entity_idx ON evidence(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS evidence_field_idx ON evidence(field_name);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  current_value TEXT,
  candidate_value TEXT,
  evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS conflicts_company_idx
  ON conflicts(company_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS conflicts_open_unique
  ON conflicts(company_id, entity_type, entity_id, field_name, candidate_value)
  WHERE status IN ('open', 'researching');

CREATE TABLE IF NOT EXISTS source_runs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  status TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  params_hash TEXT,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  edited_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at TEXT,
  sent_at TEXT,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  outcome_at TEXT,
  outcome_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS outreach_status_idx ON outreach_drafts(status, scheduled_at);

CREATE TABLE IF NOT EXISTS suppression_entries (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(value, kind)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS company_search USING fts5(
  company_id UNINDEXED,
  name,
  domain,
  description,
  industries
);
`;

export function getDatabase() {
  if (singleton) return singleton;
  const databasePath = getDatabasePath();
  singleton = trackSqliteStatements(
    new Database(databasePath, { create: true }),
  );
  try {
    assertSupportedSchemaVersion(singleton);
  } catch (error) {
    closeDatabase();
    throw error;
  }
  // Bun currently keeps WAL files locked after Database.close() on native
  // Windows. The rollback journal avoids that runtime-specific lock and keeps
  // backup restore/delete operations reliable for this single-owner app.
  singleton.exec(
    `PRAGMA journal_mode = ${process.platform === "win32" ? "DELETE" : "WAL"}`,
  );
  initializeDatabaseSchema(singleton);
  singleton
    .query(
      `UPDATE source_runs
       SET status = 'failed',
           error_message = COALESCE(error_message, 'Interrupted before completion.'),
           finished_at = COALESCE(finished_at, ?)
       WHERE status IN ('queued', 'running')`,
    )
    .run(nowIso());
  singleton.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS source_runs_active_unique
     ON source_runs(source_type, params_hash)
     WHERE params_hash IS NOT NULL AND status IN ('queued', 'running')`,
  );
  const interruptedDrafts = singleton
    .query(
      `SELECT id, company_id FROM outreach_drafts WHERE status = 'sending'`,
    )
    .all() as Array<{ id: string; company_id: string }>;
  if (interruptedDrafts.length) {
    const interruptedAt = nowIso();
    singleton.transaction(() => {
      singleton!
        .query(
          `UPDATE outreach_drafts
           SET status = 'send_unknown', updated_at = ?
           WHERE status = 'sending'`,
        )
        .run(interruptedAt);
      for (const draft of interruptedDrafts) {
        singleton!
          .query(
            `INSERT INTO audit_events (
              id, event_type, entity_type, entity_id, summary, payload_json,
              created_at
            ) VALUES (?, 'outreach.send_unknown', 'company', ?, ?, ?, ?)`,
          )
          .run(
            newId(),
            draft.company_id,
            "Recovered an interrupted Gmail send; delivery requires manual inspection",
            JSON.stringify({
              draftId: draft.id,
              reason: "Application stopped while the Gmail request was in progress.",
            }),
            interruptedAt,
          );
      }
    })();
  }
  if (process.platform !== "win32") {
    for (const filePath of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]) {
      if (existsSync(filePath)) chmodSync(filePath, 0o600);
    }
  }
  return singleton;
}

function tableExists(database: Database, tableName: string) {
  return Boolean(
    database
      .query(
        `SELECT 1 AS found FROM sqlite_master
         WHERE type = 'table' AND name = ? LIMIT 1`,
      )
      .get(tableName),
  );
}

export function readSchemaVersion(database: Database) {
  if (!tableExists(database, "schema_migrations")) return 0;
  const row = database
    .query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("The RecruitAI schema version record is invalid.");
  }
  return version;
}

export function assertSupportedSchemaVersion(database: Database) {
  const foundVersion = readSchemaVersion(database);
  if (foundVersion > SCHEMA_VERSION) {
    throw new Error(
      `This data was created by schema version ${foundVersion}, but this app supports up to ${SCHEMA_VERSION}. Upgrade RecruitAI before opening it.`,
    );
  }
  return foundVersion;
}

function columnNames(database: Database, tableName: string) {
  return database
    .query(`PRAGMA table_info('${tableName}')`)
    .all() as Array<{ name: string }>;
}

function addColumnUnlessPresent(
  database: Database,
  tableName: string,
  columnName: string,
  definition: string,
) {
  if (!columnNames(database, tableName).some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function canonicalizeSuppressions(database: Database) {
  const rows = database
    .query("SELECT id, value, kind FROM suppression_entries ORDER BY created_at ASC")
    .all() as Array<{ id: string; value: string; kind: string }>;
  database.transaction(() => {
    for (const row of rows) {
      const canonical =
        row.kind === "email"
          ? normalizeEmailAddress(row.value)
          : row.kind === "domain"
            ? normalizeDomain(row.value)
            : row.value.trim();
      if (!canonical || canonical === row.value) continue;
      const duplicate = database
        .query(
          `SELECT id FROM suppression_entries
           WHERE value = ? AND kind = ? AND id != ? LIMIT 1`,
        )
        .get(canonical, row.kind, row.id) as { id: string } | null;
      if (duplicate) {
        database.query("DELETE FROM suppression_entries WHERE id = ?").run(row.id);
      } else {
        database
          .query("UPDATE suppression_entries SET value = ? WHERE id = ?")
          .run(canonical, row.id);
      }
    }
  })();
}

function enforceSinglePrimaryContact(database: Database) {
  const duplicatePrimaries = database
    .query(
      `SELECT id, company_id FROM contacts
       WHERE status = 'primary'
       ORDER BY company_id, rank ASC, created_at ASC, id ASC`,
    )
    .all() as Array<{ id: string; company_id: string }>;
  const retainedCompanies = new Set<string>();
  database.transaction(() => {
    for (const contact of duplicatePrimaries) {
      if (!retainedCompanies.has(contact.company_id)) {
        retainedCompanies.add(contact.company_id);
        continue;
      }
      database
        .query(
          `UPDATE contacts SET status = 'alternate', reviewed = 0, updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso(), contact.id);
    }
  })();
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS contacts_one_primary_per_company
     ON contacts(company_id) WHERE status = 'primary'`,
  );
}

export function initializeDatabaseSchema(database: Database) {
  const recordedSchemaVersion = assertSupportedSchemaVersion(database);
  database.exec(schema);
  if (recordedSchemaVersion < 1) {
    database.transaction(() => {
      addColumnUnlessPresent(database, "outreach_drafts", "edited_at", "edited_at TEXT");
      addColumnUnlessPresent(database, "outreach_drafts", "outcome_at", "outcome_at TEXT");
      addColumnUnlessPresent(database, "outreach_drafts", "outcome_note", "outcome_note TEXT");
      addColumnUnlessPresent(database, "source_runs", "params_hash", "params_hash TEXT");
      addColumnUnlessPresent(
        database,
        "contacts",
        "phone_confirmed",
        "phone_confirmed INTEGER NOT NULL DEFAULT 0",
      );
      addColumnUnlessPresent(database, "contacts", "phone_source", "phone_source TEXT");
      addColumnUnlessPresent(database, "contacts", "fallback_reason", "fallback_reason TEXT");
      addColumnUnlessPresent(
        database,
        "contacts",
        "fallback_confirmed",
        "fallback_confirmed INTEGER NOT NULL DEFAULT 0",
      );
      addColumnUnlessPresent(
        database,
        "contacts",
        "employment_confirmed",
        "employment_confirmed INTEGER NOT NULL DEFAULT 0",
      );
      addColumnUnlessPresent(database, "contacts", "observed_title", "observed_title TEXT");
      addColumnUnlessPresent(
        database,
        "contacts",
        "employment_observed_at",
        "employment_observed_at TEXT",
      );
      addColumnUnlessPresent(
        database,
        "companies",
        "fit_confirmed",
        "fit_confirmed INTEGER NOT NULL DEFAULT 0",
      );
      addColumnUnlessPresent(
        database,
        "companies",
        "recruiting_fit",
        "recruiting_fit TEXT NOT NULL DEFAULT 'unknown'",
      );
      addColumnUnlessPresent(
        database,
        "companies",
        "recruiting_fit_note",
        "recruiting_fit_note TEXT",
      );
      addColumnUnlessPresent(
        database,
        "companies",
        "exclusion_reason",
        "exclusion_reason TEXT",
      );
      addColumnUnlessPresent(
        database,
        "companies",
        "exclusion_note",
        "exclusion_note TEXT",
      );
      addColumnUnlessPresent(
        database,
        "companies",
        "hiring_score_json",
        "hiring_score_json TEXT NOT NULL DEFAULT '{}'",
      );
      addColumnUnlessPresent(
        database,
        "jobs",
        "confirmed_live",
        "confirmed_live INTEGER NOT NULL DEFAULT 0",
      );
      addColumnUnlessPresent(database, "jobs", "observed_at", "observed_at TEXT");
      database
        .query(
          `INSERT INTO schema_migrations (version, applied_at)
           VALUES (1, ?)`,
        )
        .run(nowIso());
    })();
  }
  canonicalizeSuppressions(database);
  enforceSinglePrimaryContact(database);
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS source_runs_active_unique
     ON source_runs(source_type, params_hash)
     WHERE params_hash IS NOT NULL AND status IN ('queued', 'running')`,
  );
}

export function migrateDatabaseFile(filePath: string) {
  const database = trackSqliteStatements(
    new Database(filePath, { readwrite: true, create: false }),
  );
  try {
    initializeDatabaseSchema(database);
    database.exec("PRAGMA optimize");
  } finally {
    closeSqliteDatabase(database);
  }
}

export function closeDatabase() {
  if (!singleton) return;
  const database = singleton;
  singleton = null;
  closeSqliteDatabase(database);
}

export function closeSqliteDatabase(database: Database) {
  const statements = trackedStatements.get(database);
  if (statements) {
    for (const statement of statements) {
      try {
        statement.finalize();
      } catch {
        // Continue finalizing the remaining cached statements.
      }
    }
    statements.clear();
    trackedStatements.delete(database);
  }
  try {
    database.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  } catch {
    // Some SQLite builds or in-memory databases do not expose this control.
  }
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // A read-only validation connection may not permit a checkpoint.
  }
  database.close(true);
}

export function resetDatabaseForTests(databasePath: string) {
  closeDatabase();
  process.env.RECRUITAI_DATA_DIR = databasePath;
  return getDatabase();
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId() {
  return crypto.randomUUID();
}

export function normalizeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co)\b\.?/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

export function normalizeDomain(value?: string | null) {
  if (!value) return null;
  const candidate = value.trim().toLowerCase();
  if (!candidate) return null;
  try {
    const url = candidate.includes("://")
      ? new URL(candidate)
      : new URL(`https://${candidate}`);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const hostname = url.hostname
      .replace(/^www\./, "")
      .replace(/\.$/, "")
      .toLowerCase();
    const labels = hostname.split(".");
    if (
      hostname.length > 253 ||
      labels.length < 2 ||
      /^\d+(?:\.\d+){3}$/.test(hostname) ||
      labels.some(
        (label) =>
          label.length < 1 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
      ) ||
      /^\d+$/.test(labels.at(-1) || "")
    ) {
      return null;
    }
    return hostname;
  } catch {
    return null;
  }
}

export function normalizeHttpUrl(value?: string | null) {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 2_048) return null;
  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

export function normalizeEmailAddress(value?: string | null) {
  const candidate = value?.trim().toLowerCase();
  if (
    !candidate ||
    candidate.length > 320 ||
    !/^[^\s@"(),:;<>\\[\]]+@[^\s@"(),:;<>\\[\]]+\.[^\s@"(),:;<>\\[\]]+$/.test(
      candidate,
    )
  ) {
    return null;
  }
  return candidate;
}

export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
