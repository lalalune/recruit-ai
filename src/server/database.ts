import { Database, constants } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { getDatabasePath } from "./paths";

let singleton: Database | null = null;

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
  singleton = new Database(databasePath, { create: true });
  // Bun currently keeps WAL files locked after Database.close() on native
  // Windows. The rollback journal avoids that runtime-specific lock and keeps
  // backup restore/delete operations reliable for this single-owner app.
  singleton.exec(
    `PRAGMA journal_mode = ${process.platform === "win32" ? "DELETE" : "WAL"}`,
  );
  singleton.exec(schema);
  const draftColumns = singleton
    .query("PRAGMA table_info('outreach_drafts')")
    .all() as Array<{ name: string }>;
  if (!draftColumns.some((column) => column.name === "edited_at")) {
    singleton.exec("ALTER TABLE outreach_drafts ADD COLUMN edited_at TEXT");
  }
  if (!draftColumns.some((column) => column.name === "outcome_at")) {
    singleton.exec("ALTER TABLE outreach_drafts ADD COLUMN outcome_at TEXT");
  }
  if (!draftColumns.some((column) => column.name === "outcome_note")) {
    singleton.exec("ALTER TABLE outreach_drafts ADD COLUMN outcome_note TEXT");
  }
  const sourceRunColumns = singleton
    .query("PRAGMA table_info('source_runs')")
    .all() as Array<{ name: string }>;
  if (!sourceRunColumns.some((column) => column.name === "params_hash")) {
    singleton.exec("ALTER TABLE source_runs ADD COLUMN params_hash TEXT");
  }
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
  const contactColumns = singleton
    .query("PRAGMA table_info('contacts')")
    .all() as Array<{ name: string }>;
  if (!contactColumns.some((column) => column.name === "phone_confirmed")) {
    singleton.exec(
      "ALTER TABLE contacts ADD COLUMN phone_confirmed INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!contactColumns.some((column) => column.name === "phone_source")) {
    singleton.exec("ALTER TABLE contacts ADD COLUMN phone_source TEXT");
  }
  if (!contactColumns.some((column) => column.name === "fallback_reason")) {
    singleton.exec("ALTER TABLE contacts ADD COLUMN fallback_reason TEXT");
  }
  if (!contactColumns.some((column) => column.name === "fallback_confirmed")) {
    singleton.exec(
      "ALTER TABLE contacts ADD COLUMN fallback_confirmed INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!contactColumns.some((column) => column.name === "employment_confirmed")) {
    singleton.exec(
      "ALTER TABLE contacts ADD COLUMN employment_confirmed INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!contactColumns.some((column) => column.name === "observed_title")) {
    singleton.exec("ALTER TABLE contacts ADD COLUMN observed_title TEXT");
  }
  if (!contactColumns.some((column) => column.name === "employment_observed_at")) {
    singleton.exec("ALTER TABLE contacts ADD COLUMN employment_observed_at TEXT");
  }
  const companyColumns = singleton
    .query("PRAGMA table_info('companies')")
    .all() as Array<{ name: string }>;
  if (!companyColumns.some((column) => column.name === "fit_confirmed")) {
    singleton.exec(
      "ALTER TABLE companies ADD COLUMN fit_confirmed INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!companyColumns.some((column) => column.name === "recruiting_fit")) {
    singleton.exec(
      "ALTER TABLE companies ADD COLUMN recruiting_fit TEXT NOT NULL DEFAULT 'unknown'",
    );
  }
  if (!companyColumns.some((column) => column.name === "recruiting_fit_note")) {
    singleton.exec("ALTER TABLE companies ADD COLUMN recruiting_fit_note TEXT");
  }
  if (!companyColumns.some((column) => column.name === "exclusion_reason")) {
    singleton.exec("ALTER TABLE companies ADD COLUMN exclusion_reason TEXT");
  }
  if (!companyColumns.some((column) => column.name === "exclusion_note")) {
    singleton.exec("ALTER TABLE companies ADD COLUMN exclusion_note TEXT");
  }
  if (!companyColumns.some((column) => column.name === "hiring_score_json")) {
    singleton.exec(
      "ALTER TABLE companies ADD COLUMN hiring_score_json TEXT NOT NULL DEFAULT '{}'",
    );
  }
  const jobColumns = singleton
    .query("PRAGMA table_info('jobs')")
    .all() as Array<{ name: string }>;
  if (!jobColumns.some((column) => column.name === "confirmed_live")) {
    singleton.exec(
      "ALTER TABLE jobs ADD COLUMN confirmed_live INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!jobColumns.some((column) => column.name === "observed_at")) {
    singleton.exec("ALTER TABLE jobs ADD COLUMN observed_at TEXT");
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

export function closeDatabase() {
  if (!singleton) return;
  const database = singleton;
  singleton = null;
  closeSqliteDatabase(database);
}

export function closeSqliteDatabase(database: Database) {
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
  database.close();
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
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
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
    return url.hostname.replace(/^www\./, "");
  } catch {
    return candidate
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0] || null;
  }
}

export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
