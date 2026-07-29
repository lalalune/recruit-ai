import type {
  AuditItem,
  CompanyDetail,
  CompanyListItem,
  ConflictItem,
  ContactSummary,
  DashboardSummary,
  EvidenceItem,
  HiringScoreBreakdown,
  JobItem,
  OutreachDraft,
  ReadinessItem,
  SourceRunItem,
} from "../shared/types";
import { createHash } from "node:crypto";
import {
  getDatabase,
  newId,
  normalizeDomain,
  normalizeName,
  nowIso,
  safeJsonParse,
} from "./database";

type SqlValue = string | number | boolean | null;

const bayAreaLocationPattern =
  /\b(san francisco|sf bay|bay area|oakland|berkeley|alameda|emeryville|hayward|san leandro|union city|fremont|walnut creek|concord|pleasanton|dublin|livermore|san mateo|redwood city|south san francisco|daly city|burlingame|foster city|half moon bay|palo alto|menlo park|mountain view|sunnyvale|santa clara|san jose|cupertino|campbell|milpitas|los altos|los gatos|saratoga|morgan hill|marin|san rafael|novato|sausalito|napa|sonoma|santa rosa|vallejo|fairfield|solano|contra costa|silicon valley)\b/i;

export function isBayAreaLocation(value: unknown) {
  return bayAreaLocationPattern.test(String(value || ""));
}

interface CompanyInput {
  name: string;
  domain?: string | null;
  websiteUrl?: string | null;
  linkedinUrl?: string | null;
  ycUrl?: string | null;
  description?: string | null;
  location?: string | null;
  employeeCountMin?: number | null;
  employeeCountMax?: number | null;
  industries?: string[];
  stage?: string | null;
  status?: string;
  priority?: string;
}

interface EvidenceInput {
  entityType: "company" | "contact" | "job";
  entityId: string;
  fieldName: string;
  value?: string | null;
  sourceType: string;
  sourceLabel: string;
  sourceUrl?: string | null;
  excerpt?: string | null;
  screenshotPath?: string | null;
  confidence?: number;
  payload?: unknown;
}

interface JobInput {
  companyId: string;
  externalId?: string | null;
  title: string;
  location?: string | null;
  department?: string | null;
  descriptionExcerpt?: string | null;
  url?: string | null;
  sourceType: string;
  postedAt?: string | null;
  confirmedLive?: boolean;
  observedAt?: string | null;
}

function assertObservationDate(
  value: unknown,
  label: string,
  maximumAgeDays?: number,
) {
  const timestamp = Date.parse(String(value || ""));
  const age = Date.now() - timestamp;
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid date.`);
  }
  if (age < -24 * 60 * 60 * 1_000) {
    throw new Error(`${label} cannot be in the future.`);
  }
  if (
    maximumAgeDays !== undefined &&
    age > maximumAgeDays * 24 * 60 * 60 * 1_000
  ) {
    throw new Error(
      `${label} must be within the ${maximumAgeDays}-day hiring window.`,
    );
  }
}

function mapContact(row: Record<string, unknown>): ContactSummary {
  return {
    id: String(row.id),
    fullName: String(row.full_name),
    title: (row.title as string | null) ?? null,
    roleCategory: (row.role_category as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    emailType: (row.email_type as ContactSummary["emailType"]) ?? "unknown",
    fallbackReason: (row.fallback_reason as string | null) ?? null,
    fallbackConfirmed: Boolean(row.fallback_confirmed),
    emailStatus: (row.email_status as ContactSummary["emailStatus"]) ?? "unverified",
    emailVerifiedAt: (row.email_verified_at as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    phoneType: (row.phone_type as ContactSummary["phoneType"]) ?? "unknown",
    phoneConfirmed: Boolean(row.phone_confirmed),
    phoneSource: (row.phone_source as string | null) ?? null,
    linkedinUrl: (row.linkedin_url as string | null) ?? null,
    employmentConfirmed: Boolean(row.employment_confirmed),
    observedTitle: (row.observed_title as string | null) ?? null,
    employmentObservedAt:
      (row.employment_observed_at as string | null) ?? null,
    rank: Number(row.rank),
    status: row.status as ContactSummary["status"],
    reviewed: Boolean(row.reviewed),
    notes: (row.notes as string | null) ?? null,
  };
}

function mapEvidence(row: Record<string, unknown>): EvidenceItem {
  return {
    id: String(row.id),
    entityType: row.entity_type as EvidenceItem["entityType"],
    entityId: String(row.entity_id),
    fieldName: String(row.field_name),
    value: (row.value as string | null) ?? null,
    sourceType: String(row.source_type),
    sourceLabel: String(row.source_label),
    sourceUrl: (row.source_url as string | null) ?? null,
    excerpt: (row.excerpt as string | null) ?? null,
    screenshotPath: (row.screenshot_path as string | null) ?? null,
    confidence: Number(row.confidence),
    capturedAt: String(row.captured_at),
  };
}

function mapJob(row: Record<string, unknown>): JobItem {
  return {
    id: String(row.id),
    title: String(row.title),
    location: (row.location as string | null) ?? null,
    department: (row.department as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    sourceType: String(row.source_type),
    postedAt: (row.posted_at as string | null) ?? null,
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    active: Boolean(row.active),
    confirmedLive: Boolean(row.confirmed_live),
    observedAt: (row.observed_at as string | null) ?? null,
  };
}

function mapConflict(row: Record<string, unknown>): ConflictItem {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    entityType: row.entity_type as ConflictItem["entityType"],
    entityId: String(row.entity_id),
    fieldName: String(row.field_name),
    currentValue: (row.current_value as string | null) ?? null,
    candidateValue: (row.candidate_value as string | null) ?? null,
    evidenceId: (row.evidence_id as string | null) ?? null,
    status: row.status as ConflictItem["status"],
    resolution: (row.resolution as ConflictItem["resolution"]) ?? null,
    resolutionNote: (row.resolution_note as string | null) ?? null,
    createdAt: String(row.created_at),
    resolvedAt: (row.resolved_at as string | null) ?? null,
  };
}

function mapAudit(row: Record<string, unknown>): AuditItem {
  return {
    id: String(row.id),
    eventType: String(row.event_type),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    summary: String(row.summary),
    payload: safeJsonParse(row.payload_json as string | null, null),
    createdAt: String(row.created_at),
  };
}

export function addAudit(
  eventType: string,
  entityType: string,
  entityId: string,
  summary: string,
  payload?: unknown,
) {
  getDatabase()
    .query(
      `INSERT INTO audit_events
       (id, event_type, entity_type, entity_id, summary, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      eventType,
      entityType,
      entityId,
      summary,
      payload === undefined ? null : JSON.stringify(payload),
      nowIso(),
    );
}

export function upsertCompany(input: CompanyInput) {
  const db = getDatabase();
  const normalized = normalizeName(input.name);
  const domain = normalizeDomain(input.domain || input.websiteUrl);
  let existing = domain
    ? db
        .query("SELECT * FROM companies WHERE domain = ? LIMIT 1")
        .get(domain) as Record<string, unknown> | null
    : null;
  if (!existing) {
    const nameMatches = db
      .query(
        `SELECT * FROM companies
         WHERE normalized_name = ?
         ORDER BY CASE WHEN domain IS NULL OR domain = '' THEN 0 ELSE 1 END,
           updated_at DESC
         LIMIT 20`,
      )
      .all(normalized) as Record<string, unknown>[];
    const incomingLocation = input.location?.trim().toLowerCase() || "";
    const compatibleMatches = nameMatches.filter((row) => {
      const existingLocation = String(row.location || "").trim().toLowerCase();
      return incomingLocation
        ? !existingLocation || existingLocation === incomingLocation
        : !existingLocation;
    });
    if (!domain) {
      existing =
        compatibleMatches.length === 1 ? compatibleMatches[0] : null;
    } else {
      const domainlessMatches = compatibleMatches.filter((row) => !row.domain);
      // A domain-bearing provider record should enrich a single domainless seed
      // rather than produce a duplicate.
      existing = domainlessMatches.length === 1 ? domainlessMatches[0] : null;
    }
  }

  const timestamp = nowIso();
  if (existing) {
    const id = String(existing.id);
    const previousName = String(existing.name);
    const mergedIndustries = Array.from(
      new Set([
        ...safeJsonParse<string[]>(existing.industries_json as string, []),
        ...(input.industries ?? []),
      ]),
    );
    db.query(
      `UPDATE companies SET
        name = CASE WHEN length(?) > length(name) THEN ? ELSE name END,
        normalized_name = ?,
        domain = COALESCE(domain, ?),
        website_url = COALESCE(website_url, ?),
        linkedin_url = COALESCE(linkedin_url, ?),
        yc_url = COALESCE(yc_url, ?),
        description = CASE
          WHEN description IS NULL OR length(?) > length(description) THEN ?
          ELSE description END,
        location = COALESCE(location, ?),
        employee_count_min = COALESCE(?, employee_count_min),
        employee_count_max = COALESCE(?, employee_count_max),
        industries_json = ?,
        stage = COALESCE(?, stage),
        status = CASE WHEN status = 'new' THEN COALESCE(?, status) ELSE status END,
        priority = COALESCE(?, priority),
        updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name,
      input.name,
      normalized,
      domain,
      input.websiteUrl ?? (domain ? `https://${domain}` : null),
      input.linkedinUrl ?? null,
      input.ycUrl ?? null,
      input.description ?? "",
      input.description ?? null,
      input.location ?? null,
      input.employeeCountMin ?? null,
      input.employeeCountMax ?? null,
      JSON.stringify(mergedIndustries),
      input.stage ?? null,
      input.status ?? "needs_research",
      input.priority ?? null,
      timestamp,
      id,
    );
    syncCompanySearch(id);
    if (normalizeName(previousName) !== normalizeName(input.name)) {
      saveCompanyAlias(id, previousName, "historical");
      saveCompanyAlias(id, input.name, "upsert");
      refreshNameConflicts(normalizeName(previousName));
    }
    refreshNameConflicts(normalized);
    return { id, inserted: false };
  }

  const id = newId();
  db.query(
    `INSERT INTO companies (
      id, name, normalized_name, domain, website_url, linkedin_url, yc_url,
      description, location, employee_count_min, employee_count_max,
      industries_json, stage, status, priority, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    normalized,
    domain,
    input.websiteUrl ?? (domain ? `https://${domain}` : null),
    input.linkedinUrl ?? null,
    input.ycUrl ?? null,
    input.description ?? null,
    input.location ?? null,
    input.employeeCountMin ?? null,
    input.employeeCountMax ?? null,
    JSON.stringify(input.industries ?? []),
    input.stage ?? null,
    input.status ?? "needs_research",
    input.priority ?? "medium",
    timestamp,
    timestamp,
  );
  syncCompanySearch(id);
  refreshNameConflicts(normalized);
  addAudit("company.created", "company", id, `Added ${input.name}`, {
    domain,
  });
  return { id, inserted: true };
}

function saveCompanyAlias(
  companyId: string,
  alias: string,
  sourceType: string,
) {
  const normalizedAlias = normalizeName(alias);
  if (!normalizedAlias) return;
  getDatabase()
    .query(
      `INSERT INTO company_aliases
       (id, company_id, alias, normalized_alias, source_type)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(company_id, normalized_alias) DO UPDATE SET
         alias = excluded.alias,
         source_type = excluded.source_type`,
    )
    .run(newId(), companyId, alias.trim(), normalizedAlias, sourceType);
}

function refreshNameConflicts(normalizedName: string) {
  const database = getDatabase();
  const rows = database
    .query(
      `SELECT id, name, domain, location FROM companies
       WHERE normalized_name = ? ORDER BY created_at ASC`,
    )
    .all(normalizedName) as Array<{
    id: string;
    name: string;
    domain: string | null;
    location: string | null;
  }>;
  const timestamp = nowIso();
  if (rows.length < 2) {
    for (const row of rows) {
      database
        .query(
          `UPDATE conflicts SET status = 'resolved',
            resolution = 'keep_current',
            resolution_note = COALESCE(
              resolution_note,
              'Identity collision cleared by a later company update.'
            ),
            resolved_at = COALESCE(resolved_at, ?)
           WHERE company_id = ? AND field_name = 'identity'
             AND status IN ('open', 'researching')`,
        )
        .run(timestamp, row.id);
      recomputeConflictCount(row.id);
    }
    return;
  }
  for (const row of rows) {
    const candidate = rows
      .filter((other) => other.id !== row.id)
      .map(
        (other) =>
          `${other.name} · ${other.domain || "no domain"} · ${other.location || "no location"}`,
      )
      .join("; ");
    const existing = database
      .query(
        `SELECT id FROM conflicts
         WHERE company_id = ? AND field_name = 'identity'
           AND candidate_value = ? LIMIT 1`,
      )
      .get(row.id, candidate) as { id: string } | null;
    if (!existing) {
      database
        .query(
          `INSERT INTO conflicts (
            id, company_id, entity_type, entity_id, field_name, current_value,
            candidate_value, status, created_at
          ) VALUES (?, ?, 'company', ?, 'identity', ?, ?, 'open', ?)`,
        )
        .run(
          newId(),
          row.id,
          row.id,
          `${row.name} · ${row.domain || "no domain"} · ${row.location || "no location"}`,
          candidate,
          timestamp,
        );
    }
    recomputeConflictCount(row.id);
  }
}

function syncCompanySearch(companyId: string) {
  const db = getDatabase();
  const row = db
    .query(
      "SELECT id, name, domain, description, industries_json FROM companies WHERE id = ?",
    )
    .get(companyId) as Record<string, unknown> | null;
  if (!row) return;
  db.query("DELETE FROM company_search WHERE company_id = ?").run(companyId);
  db.query(
    `INSERT INTO company_search (company_id, name, domain, description, industries)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    companyId,
    String(row.name),
    (row.domain as string | null) ?? null,
    (row.description as string | null) ?? null,
    safeJsonParse<string[]>(row.industries_json as string, []).join(" "),
  );
}

export function addEvidence(input: EvidenceInput) {
  const id = newId();
  const database = getDatabase();
  database
    .query(
      `INSERT INTO evidence (
        id, entity_type, entity_id, field_name, value, source_type,
        source_label, source_url, excerpt, screenshot_path, confidence,
        captured_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.entityType,
      input.entityId,
      input.fieldName,
      input.value ?? null,
      input.sourceType,
      input.sourceLabel,
      input.sourceUrl ?? null,
      input.excerpt ?? null,
      input.screenshotPath ?? null,
      input.confidence ?? 0.6,
      nowIso(),
      input.payload === undefined ? null : JSON.stringify(input.payload),
    );
  registerEvidenceConflict(id, input);
  const companyId = evidenceCompanyId(input.entityType, input.entityId);
  if (companyId) recomputeCompanyStats(companyId);
  return id;
}

function evidenceCompanyId(
  entityType: EvidenceInput["entityType"],
  entityId: string,
) {
  if (entityType === "company") return entityId;
  const table = entityType === "contact" ? "contacts" : "jobs";
  const row = getDatabase()
    .query(`SELECT company_id FROM ${table} WHERE id = ?`)
    .get(entityId) as { company_id: string } | null;
  return row?.company_id ?? null;
}

const conflictFieldAliases: Record<string, string> = {
  company_name: "name",
  legal_name: "name",
  domain: "domain",
  website_domain: "domain",
  location: "location",
  headquarters: "location",
  employee_count: "employee_count",
  employees: "employee_count",
  industries: "industries",
  industry: "industries",
  stage: "stage",
  current_role: "title",
  title: "title",
  email: "email",
  phone: "phone",
};

function normalizedFact(value: string | null | undefined) {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function conflictContext(input: EvidenceInput): {
  companyId: string;
  canonicalField: string;
  currentValue: string | null;
} | null {
  const canonicalField = conflictFieldAliases[input.fieldName.toLowerCase()];
  if (!canonicalField || !input.value?.trim()) return null;
  const database = getDatabase();
  if (input.entityType === "company") {
    const row = database
      .query(
        `SELECT id, name, domain, location, employee_count_min,
          employee_count_max, industries_json, stage
         FROM companies WHERE id = ?`,
      )
      .get(input.entityId) as Record<string, unknown> | null;
    if (!row) return null;
    const currentValue =
      canonicalField === "employee_count"
        ? row.employee_count_min === null && row.employee_count_max === null
          ? null
          : `${row.employee_count_min ?? "?"}–${row.employee_count_max ?? "?"}`
        : canonicalField === "industries"
          ? safeJsonParse<string[]>(row.industries_json as string, []).join(", ")
          : ((row[canonicalField] as string | null) ?? null);
    return { companyId: String(row.id), canonicalField, currentValue };
  }
  if (input.entityType === "contact") {
    const row = database
      .query(
        `SELECT company_id, title, email, phone
         FROM contacts WHERE id = ?`,
      )
      .get(input.entityId) as Record<string, unknown> | null;
    if (!row || !["title", "email", "phone"].includes(canonicalField)) return null;
    return {
      companyId: String(row.company_id),
      canonicalField,
      currentValue: (row[canonicalField] as string | null) ?? null,
    };
  }
  return null;
}

function registerEvidenceConflict(evidenceId: string, input: EvidenceInput) {
  const context = conflictContext(input);
  if (
    !context?.currentValue ||
    normalizedFact(context.currentValue) === normalizedFact(input.value)
  ) {
    return;
  }
  const database = getDatabase();
  database
    .query(
      `INSERT INTO conflicts (
        id, company_id, entity_type, entity_id, field_name, current_value,
        candidate_value, evidence_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
      ON CONFLICT(company_id, entity_type, entity_id, field_name, candidate_value)
      WHERE status IN ('open', 'researching')
      DO UPDATE SET evidence_id = excluded.evidence_id,
        current_value = excluded.current_value,
        status = 'open'`,
    )
    .run(
      newId(),
      context.companyId,
      input.entityType,
      input.entityId,
      context.canonicalField,
      context.currentValue,
      input.value ?? null,
      evidenceId,
      nowIso(),
    );
  recomputeConflictCount(context.companyId);
  reopenCompanyReview(
    context.companyId,
    `New conflicting evidence for ${context.canonicalField}.`,
  );
}

function recomputeConflictCount(companyId: string) {
  const database = getDatabase();
  const evidence = database
    .query(
      `SELECT COUNT(*) AS count FROM conflicts
       WHERE company_id = ? AND status IN ('open', 'researching')`,
    )
    .get(companyId) as { count: number };
  database
    .query("UPDATE companies SET conflict_count = ? WHERE id = ?")
    .run(Number(evidence.count), companyId);
}

export function getEvidence(evidenceId: string): EvidenceItem | null {
  const row = getDatabase()
    .query("SELECT * FROM evidence WHERE id = ?")
    .get(evidenceId) as Record<string, unknown> | null;
  return row ? mapEvidence(row) : null;
}

export function upsertJob(input: JobInput) {
  const db = getDatabase();
  const timestamp = nowIso();
  const externalId = input.externalId || input.url || `${input.title}:${input.location || ""}`;
  const existing = db
    .query(
      `SELECT id, title, location, department, url, posted_at, active,
        confirmed_live, observed_at FROM jobs
       WHERE company_id = ? AND source_type = ? AND external_id = ?`,
    )
    .get(input.companyId, input.sourceType, externalId) as {
      id: string;
      title: string;
      location: string | null;
      department: string | null;
      url: string | null;
      posted_at: string | null;
      active: number;
      confirmed_live: number;
      observed_at: string | null;
    } | null;
  if (existing) {
    const materialChanged =
      existing.title !== input.title ||
      existing.location !== (input.location ?? null) ||
      existing.department !== (input.department ?? null) ||
      existing.url !== (input.url ?? null) ||
      (input.postedAt !== undefined &&
        input.postedAt !== null &&
        existing.posted_at !== input.postedAt) ||
      (input.confirmedLive !== undefined &&
        existing.confirmed_live !== (input.confirmedLive ? 1 : 0)) ||
      existing.active !== 1;
    db.query(
      `UPDATE jobs SET
        title = ?, location = ?, department = ?, description_excerpt = ?,
        url = ?, posted_at = COALESCE(?, posted_at), last_seen_at = ?,
        active = 1, confirmed_live = COALESCE(?, confirmed_live),
        observed_at = COALESCE(?, observed_at)
       WHERE id = ?`,
    ).run(
      input.title,
      input.location ?? null,
      input.department ?? null,
      input.descriptionExcerpt ?? null,
      input.url ?? null,
      input.postedAt ?? null,
      timestamp,
      input.confirmedLive === undefined ? null : input.confirmedLive ? 1 : 0,
      input.observedAt ?? null,
      existing.id,
    );
    recomputeCompanyStats(input.companyId);
    if (materialChanged) {
      reopenCompanyReview(input.companyId, "Hiring evidence changed.");
    }
    return { id: existing.id, inserted: false };
  }
  const id = newId();
  db.query(
    `INSERT INTO jobs (
      id, company_id, external_id, title, location, department,
      description_excerpt, url, source_type, posted_at, first_seen_at,
      last_seen_at, active, confirmed_live, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    input.companyId,
    externalId,
    input.title,
    input.location ?? null,
    input.department ?? null,
    input.descriptionExcerpt ?? null,
    input.url ?? null,
    input.sourceType,
    input.postedAt ?? null,
    timestamp,
    timestamp,
    input.confirmedLive ? 1 : 0,
    input.observedAt ?? timestamp,
  );
  recomputeCompanyStats(input.companyId);
  reopenCompanyReview(input.companyId, "New hiring evidence added.");
  return { id, inserted: true };
}

function reopenCompanyReview(companyId: string, reason: string) {
  const result = getDatabase()
    .query(
      `UPDATE companies SET reviewed = 0,
        status = CASE WHEN status = 'approved' THEN 'ready_for_review' ELSE status END,
        updated_at = ?
       WHERE id = ? AND reviewed = 1`,
    )
    .run(nowIso(), companyId);
  if (result.changes) {
    addAudit("company.review_reopened", "company", companyId, reason);
  }
}

export function recomputeCompanyStats(companyId: string) {
  const db = getDatabase();
  const settings = getSettings();
  const configuredWindow = Number(settings.jobFreshnessDays);
  const hiringWindowDays = Number.isFinite(configuredWindow)
    ? Math.min(180, Math.max(30, Math.floor(configuredWindow)))
    : 180;
  const strongWindowDays = Math.min(45, hiringWindowDays);
  const observationExpression = `CASE
    WHEN source_type = 'manual' THEN COALESCE(observed_at, last_seen_at)
    ELSE last_seen_at
  END`;
  const counts = db
    .query(
      `SELECT
        COUNT(*) AS open_count,
        SUM(CASE
          WHEN datetime(${observationExpression}) >= datetime('now', ?)
          THEN 1 ELSE 0 END
        ) AS fresh_count
        ,
        SUM(CASE
          WHEN julianday(last_seen_at) - julianday(first_seen_at) >= 7
          THEN 1 ELSE 0 END
        ) AS repeated_count,
        SUM(CASE
          WHEN source_type IN ('greenhouse', 'lever', 'ashby', 'company_website')
            OR (source_type = 'manual' AND confirmed_live = 1)
          THEN 1 ELSE 0 END
        ) AS strong_source_count
       FROM jobs
       WHERE company_id = ? AND active = 1
         AND datetime(${observationExpression}) >= datetime('now', ?)`,
    )
    .get(
      `-${strongWindowDays} days`,
      companyId,
      `-${hiringWindowDays} days`,
    ) as {
      open_count: number;
      fresh_count: number | null;
      repeated_count: number | null;
      strong_source_count: number | null;
    };
  const company = db
    .query(
      `SELECT domain, website_url, location, employee_count_min,
        employee_count_max, industries_json, fit_confirmed, recruiting_fit
       FROM companies WHERE id = ?`,
    )
    .get(companyId) as Record<string, unknown>;
  const evidenceCounts = db
    .query(
      `SELECT
        COUNT(*) AS company_evidence,
        (SELECT COUNT(*) FROM evidence
          WHERE entity_type = 'contact' AND entity_id IN (
            SELECT id FROM contacts WHERE company_id = ?
          )) AS contact_evidence
       FROM evidence
       WHERE entity_type = 'company' AND entity_id = ?`,
    )
    .get(companyId, companyId) as {
      company_evidence: number;
      contact_evidence: number;
    };
  const open = Number(counts.open_count || 0);
  const fresh = Number(counts.fresh_count || 0);
  const repeated = Number(counts.repeated_count || 0);
  const strongSources = Number(counts.strong_source_count || 0);
  const locationFit = isBayAreaLocation(company.location);
  const sizeFit =
    Number(company.employee_count_min) >= 3 &&
    Number(company.employee_count_max) <= 1_000 &&
    Number(company.employee_count_min) <= Number(company.employee_count_max);
  const technologyFit =
    safeJsonParse<string[]>(company.industries_json as string, []).length > 0;
  const breakdown: HiringScoreBreakdown = {
    liveHiring: open > 0 ? Math.min(40, 20 + open * 6) : 0,
    freshness: Math.min(15, fresh * 5) + (repeated > 0 ? 5 : 0),
    companyFit:
      (locationFit ? 5 : 0) +
      (sizeFit ? 5 : 0) +
      (technologyFit ? 3 : 0) +
      (Boolean(company.fit_confirmed) ? 2 : 0),
    externalHelpFit:
      company.recruiting_fit === "likely"
        ? 15
        : company.recruiting_fit === "unknown"
          ? 5
          : 0,
    evidenceQuality:
      (company.domain && company.website_url ? 2 : 0) +
      (Number(evidenceCounts.company_evidence) >= 2 ? 3 : 0) +
      (strongSources > 0 ? 3 : 0) +
      (Number(evidenceCounts.contact_evidence) > 0 ? 2 : 0),
  };
  const score = Math.min(
    100,
    Object.values(breakdown).reduce((sum, value) => sum + value, 0),
  );
  db.query(
    `UPDATE companies SET
      open_roles_count = ?, fresh_roles_count = ?, hiring_score = ?,
      hiring_score_json = ?,
      priority = CASE
        WHEN ? = 1 AND ? > 0 THEN 'high'
        ELSE priority
      END,
      status = CASE
        WHEN ? > 0 AND status IN ('new', 'needs_research') THEN 'ready_for_review'
        ELSE status END,
      updated_at = ?
     WHERE id = ?`,
  ).run(
    open,
    fresh,
    score,
    JSON.stringify(breakdown),
    settings.autoPrioritizeHiring === false ? 0 : 1,
    open,
    open,
    nowIso(),
    companyId,
  );
}

export function recomputeAllCompanyStats() {
  const ids = getDatabase()
    .query("SELECT id FROM companies")
    .all() as Array<{ id: string }>;
  getDatabase().transaction(() => {
    for (const { id } of ids) recomputeCompanyStats(id);
  })();
  return ids.length;
}

export function repairMissingCompanyStats() {
  const rows = getDatabase()
    .query("SELECT id, hiring_score_json FROM companies")
    .all() as Array<{ id: string; hiring_score_json: string | null }>;
  const requiredKeys: Array<keyof HiringScoreBreakdown> = [
    "liveHiring",
    "freshness",
    "companyFit",
    "externalHelpFit",
    "evidenceQuality",
  ];
  const ids = rows
    .filter((row) => {
      const breakdown = safeJsonParse<Partial<HiringScoreBreakdown> | null>(
        row.hiring_score_json || "",
        null,
      );
      return (
        !breakdown ||
        requiredKeys.some(
          (key) =>
            typeof breakdown[key] !== "number" ||
            !Number.isFinite(breakdown[key]),
        )
      );
    })
    .map((row) => row.id);
  if (!ids.length) return 0;
  getDatabase().transaction(() => {
    for (const id of ids) recomputeCompanyStats(id);
  })();
  return ids.length;
}

function selectCompanyRows(where: string, params: SqlValue[], order: string) {
  return getDatabase()
    .query(
      `SELECT
        c.*,
        (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id) AS contact_count,
        (SELECT group_concat(DISTINCT e.source_label)
          FROM evidence e WHERE e.entity_type = 'company' AND e.entity_id = c.id
        ) AS source_labels,
        pc.id AS pc_id,
        pc.full_name AS pc_full_name,
        pc.title AS pc_title,
        pc.role_category AS pc_role_category,
        pc.email AS pc_email,
        pc.email_type AS pc_email_type,
        pc.fallback_reason AS pc_fallback_reason,
        pc.fallback_confirmed AS pc_fallback_confirmed,
        pc.email_status AS pc_email_status,
        pc.email_verified_at AS pc_email_verified_at,
        pc.phone AS pc_phone,
        pc.phone_type AS pc_phone_type,
        pc.phone_confirmed AS pc_phone_confirmed,
        pc.phone_source AS pc_phone_source,
        pc.linkedin_url AS pc_linkedin_url,
        pc.employment_confirmed AS pc_employment_confirmed,
        pc.observed_title AS pc_observed_title,
        pc.employment_observed_at AS pc_employment_observed_at,
        pc.rank AS pc_rank,
        pc.status AS pc_status,
        pc.reviewed AS pc_reviewed,
        pc.notes AS pc_notes
      FROM companies c
      LEFT JOIN contacts pc ON pc.id = (
        SELECT id FROM contacts
        WHERE company_id = c.id
          AND status NOT IN ('invalid', 'left_company', 'suppressed')
        ORDER BY CASE WHEN status = 'primary' THEN 0 ELSE 1 END, rank ASC
        LIMIT 1
      )
      ${where}
      ${order}`,
    )
    .all(...params) as Record<string, unknown>[];
}

function mapCompanyListItem(row: Record<string, unknown>): CompanyListItem {
  const primaryContact = row.pc_id
    ? mapContact({
        id: row.pc_id,
        full_name: row.pc_full_name,
        title: row.pc_title,
        role_category: row.pc_role_category,
        email: row.pc_email,
        email_type: row.pc_email_type,
        fallback_reason: row.pc_fallback_reason,
        fallback_confirmed: row.pc_fallback_confirmed,
        email_status: row.pc_email_status,
        email_verified_at: row.pc_email_verified_at,
        phone: row.pc_phone,
        phone_type: row.pc_phone_type,
        phone_confirmed: row.pc_phone_confirmed,
        phone_source: row.pc_phone_source,
        linkedin_url: row.pc_linkedin_url,
        employment_confirmed: row.pc_employment_confirmed,
        observed_title: row.pc_observed_title,
        employment_observed_at: row.pc_employment_observed_at,
        rank: row.pc_rank,
        status: row.pc_status,
        reviewed: row.pc_reviewed,
        notes: row.pc_notes,
      })
    : null;
  return {
    id: String(row.id),
    name: String(row.name),
    domain: (row.domain as string | null) ?? null,
    websiteUrl: (row.website_url as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    employeeCountMin: (row.employee_count_min as number | null) ?? null,
    employeeCountMax: (row.employee_count_max as number | null) ?? null,
    industries: safeJsonParse<string[]>(row.industries_json as string, []),
    stage: (row.stage as string | null) ?? null,
    status: row.status as CompanyListItem["status"],
    priority: row.priority as CompanyListItem["priority"],
    fitConfirmed: Boolean(row.fit_confirmed),
    recruitingFit:
      (row.recruiting_fit as CompanyListItem["recruitingFit"]) || "unknown",
    recruitingFitNote: (row.recruiting_fit_note as string | null) ?? null,
    exclusionReason: (row.exclusion_reason as string | null) ?? null,
    reviewed: Boolean(row.reviewed),
    hiringScore: Number(row.hiring_score),
    hiringScoreBreakdown: {
      liveHiring: 0,
      freshness: 0,
      companyFit: 0,
      externalHelpFit: 0,
      evidenceQuality: 0,
      ...safeJsonParse<Partial<HiringScoreBreakdown>>(
        row.hiring_score_json as string,
        {},
      ),
    },
    openRolesCount: Number(row.open_roles_count),
    freshRolesCount: Number(row.fresh_roles_count),
    conflictCount: Number(row.conflict_count),
    primaryContact,
    sourceLabels: row.source_labels
      ? String(row.source_labels).split(",").filter(Boolean)
      : [],
    updatedAt: String(row.updated_at),
  };
}

export function listCompanies(input: {
  search?: string;
  status?: string;
  reviewed?: string;
  priority?: string;
  hasOpenRoles?: string;
  needs?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  if (input.search) {
    conditions.push(
      `(c.name LIKE ? OR c.domain LIKE ? OR c.description LIKE ? OR c.industries_json LIKE ?)`,
    );
    const query = `%${input.search}%`;
    params.push(query, query, query, query);
  }
  if (input.status && input.status !== "all") {
    conditions.push("c.status = ?");
    params.push(input.status);
  }
  if (input.reviewed === "true" || input.reviewed === "false") {
    conditions.push("c.reviewed = ?");
    params.push(input.reviewed === "true" ? 1 : 0);
  }
  if (input.priority && input.priority !== "all") {
    conditions.push("c.priority = ?");
    params.push(input.priority);
  }
  if (input.hasOpenRoles === "true") {
    conditions.push("c.open_roles_count > 0");
  }
  if (input.needs === "fresh_jobs") {
    conditions.push("c.fresh_roles_count > 0");
  } else if (input.needs === "missing_decision_maker") {
    conditions.push(
      `NOT EXISTS (
        SELECT 1 FROM contacts need_ct
        WHERE need_ct.company_id = c.id AND need_ct.status = 'primary'
          AND need_ct.employment_confirmed = 1
      )`,
    );
  } else if (input.needs === "missing_email") {
    conditions.push(
      `NOT EXISTS (
        SELECT 1 FROM contacts need_ct
        WHERE need_ct.company_id = c.id AND need_ct.status = 'primary'
          AND need_ct.email IS NOT NULL AND need_ct.email != ''
      )`,
    );
  } else if (input.needs === "email_verification") {
    const freshnessDays = Math.min(
      30,
      Math.max(1, Number(getSettings().emailFreshnessDays) || 30),
    );
    conditions.push(
      `EXISTS (
        SELECT 1 FROM contacts need_ct
        WHERE need_ct.company_id = c.id AND need_ct.status = 'primary'
          AND need_ct.email IS NOT NULL
          AND (
            need_ct.email_status != 'valid'
            OR need_ct.email_verified_at IS NULL
            OR datetime(need_ct.email_verified_at) < datetime('now', ?)
          )
      )`,
    );
    params.push(`-${freshnessDays} days`);
  } else if (input.needs === "conflicts") {
    conditions.push("c.conflict_count > 0");
  } else if (input.needs === "ready_final") {
    conditions.push(
      `c.fit_confirmed = 1
       AND c.recruiting_fit = 'likely'
       AND c.open_roles_count > 0
       AND c.conflict_count = 0
       AND c.exclusion_reason IS NULL`,
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(input.limit ?? 100, 500);
  const offset = Math.max(input.offset ?? 0, 0);
  params.push(limit, offset);
  const orderBy: Record<string, string> = {
    hiring: "c.reviewed ASC, c.hiring_score DESC, c.updated_at DESC",
    recent: "c.reviewed ASC, COALESCE(c.last_researched_at, c.updated_at) DESC",
    roles: "c.reviewed ASC, c.open_roles_count DESC, c.hiring_score DESC",
    name: "c.name COLLATE NOCASE ASC",
    oldest: "c.reviewed ASC, c.updated_at ASC",
  };
  const rows = selectCompanyRows(
    `${where}`,
    params,
    `ORDER BY ${orderBy[input.sort || "hiring"] || orderBy.hiring} LIMIT ? OFFSET ?`,
  );
  const countParams = params.slice(0, -2);
  const count = getDatabase()
    .query(`SELECT COUNT(*) AS count FROM companies c ${where}`)
    .get(...countParams) as { count: number };
  return {
    items: rows.map(mapCompanyListItem),
    total: Number(count.count),
    limit,
    offset,
  };
}

export function listCompaniesMissingDomain(limit: number) {
  return (
    getDatabase()
      .query(
        `SELECT id FROM companies
         WHERE domain IS NULL OR domain = ''
         ORDER BY reviewed ASC, hiring_score DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(Math.min(10_000, Math.max(1, limit))) as Array<{ id: string }>
  ).map((row) => row.id);
}

export function listCompaniesForWebsiteResearch(limit: number) {
  const refreshDays = Math.min(
    365,
    Math.max(7, Number(getSettings().jobRefreshDays) || 90),
  );
  return (
    getDatabase()
      .query(
        `SELECT id FROM companies
         WHERE (website_url IS NOT NULL OR domain IS NOT NULL)
           AND status NOT IN ('rejected', 'archived')
           AND (
             last_researched_at IS NULL
             OR datetime(last_researched_at) < datetime('now', ?)
           )
         ORDER BY
           CASE WHEN last_researched_at IS NULL THEN 0 ELSE 1 END,
           hiring_score DESC,
           updated_at ASC
         LIMIT ?`,
      )
      .all(
        `-${refreshDays} days`,
        Math.min(10_000, Math.max(1, limit)),
      ) as Array<{ id: string }>
  ).map((row) => row.id);
}

export function getCompany(companyId: string): CompanyDetail | null {
  const rows = selectCompanyRows("WHERE c.id = ?", [companyId], "");
  if (!rows[0]) return null;
  const db = getDatabase();
  const base = mapCompanyListItem(rows[0]);
  const contacts = db
    .query("SELECT * FROM contacts WHERE company_id = ? ORDER BY rank ASC, created_at ASC")
    .all(companyId)
    .map((row) => mapContact(row as Record<string, unknown>));
  const jobs = db
    .query(
      "SELECT * FROM jobs WHERE company_id = ? ORDER BY active DESC, COALESCE(posted_at, first_seen_at) DESC",
    )
    .all(companyId)
    .map((row) => mapJob(row as Record<string, unknown>));
  const contactIds = contacts.map((contact) => contact.id);
  const jobIds = jobs.map((job) => job.id);
  const contactPlaceholders = contactIds.map(() => "?").join(",");
  const jobPlaceholders = jobIds.map(() => "?").join(",");
  const evidenceWhere = [
    `(entity_type = 'company' AND entity_id = ?)`,
    contactIds.length
      ? `(entity_type = 'contact' AND entity_id IN (${contactPlaceholders}))`
      : null,
    jobIds.length
      ? `(entity_type = 'job' AND entity_id IN (${jobPlaceholders}))`
      : null,
  ]
    .filter(Boolean)
    .join(" OR ");
  const evidence = db
    .query(
      `SELECT * FROM evidence WHERE ${evidenceWhere}
       ORDER BY captured_at DESC`,
    )
    .all(companyId, ...contactIds, ...jobIds)
    .map((row) => mapEvidence(row as Record<string, unknown>));
  const conflicts = db
    .query(
      `SELECT * FROM conflicts WHERE company_id = ?
       ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'researching' THEN 1 ELSE 2 END,
         created_at DESC`,
    )
    .all(companyId)
    .map((row) => mapConflict(row as Record<string, unknown>));
  const audit = db
    .query(
      `SELECT * FROM audit_events
       WHERE (entity_type = 'company' AND entity_id = ?)
          OR (entity_type = 'contact' AND entity_id IN (
            SELECT id FROM contacts WHERE company_id = ?
          ))
       ORDER BY created_at DESC LIMIT 100`,
    )
    .all(companyId, companyId)
    .map((row) => mapAudit(row as Record<string, unknown>));
  const row = rows[0];
  const detail: CompanyDetail = {
    ...base,
    linkedinUrl: (row.linkedin_url as string | null) ?? null,
    ycUrl: (row.yc_url as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    exclusionNote: (row.exclusion_note as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    lastResearchedAt: (row.last_researched_at as string | null) ?? null,
    contacts,
    jobs,
    evidence,
    conflicts,
    audit,
    readiness: [],
  };
  detail.readiness = buildCompanyReadiness(detail);
  return detail;
}

function buildCompanyReadiness(company: CompanyDetail): ReadinessItem[] {
  const settings = getSettings();
  const bayArea = isBayAreaLocation(company.location);
  const sizeFit =
    company.employeeCountMin !== null &&
    company.employeeCountMax !== null &&
    company.employeeCountMin >= 3 &&
    company.employeeCountMax <= 1_000 &&
    company.employeeCountMin <= company.employeeCountMax;
  const technologyFit = company.industries.length > 0;
  const recruitingFit = company.recruitingFit === "likely";
  const excluded = Boolean(company.exclusionReason);
  const primary = company.contacts.find((contact) => contact.status === "primary");
  const employmentAge = primary?.employmentObservedAt
    ? Date.now() - Date.parse(primary.employmentObservedAt)
    : Number.NaN;
  const employmentCurrent =
    Boolean(
      primary?.reviewed &&
        primary.employmentConfirmed &&
        primary.observedTitle?.trim(),
    ) &&
    Number.isFinite(employmentAge) &&
    employmentAge >= -24 * 60 * 60 * 1_000 &&
    employmentAge <= 180 * 24 * 60 * 60 * 1_000;
  const fallbackDocumented =
    primary?.emailType === "work" ||
    (primary?.fallbackConfirmed &&
      Boolean(primary?.fallbackReason?.trim()) &&
      ["personal", "generic"].includes(primary?.emailType || ""));
  const freshnessDays = Math.min(
    30,
    Math.max(1, Number(settings.emailFreshnessDays) || 30),
  );
  const jobRefreshDays = Math.min(
    365,
    Math.max(7, Number(settings.jobRefreshDays) || 90),
  );
  const hiringWindowDays = Math.min(
    180,
    Math.max(30, Number(settings.jobFreshnessDays) || 180),
  );
  const approvalHiringAgeDays = Math.min(
    hiringWindowDays,
    jobRefreshDays,
  );
  const freshHiringJobs = company.jobs.filter((job) => {
    if (!job.active) return false;
    const observed =
      job.sourceType === "manual"
        ? job.observedAt || job.lastSeenAt
        : job.lastSeenAt;
    const age = Date.now() - Date.parse(observed);
    return (
      Number.isFinite(age) &&
      age >= -24 * 60 * 60 * 1_000 &&
      age <= approvalHiringAgeDays * 24 * 60 * 60 * 1_000
    );
  });
  const approvalHiringSources = new Set([
    "greenhouse",
    "lever",
    "ashby",
    "company_website",
    "demo",
  ]);
  const currentHiringEvidence = freshHiringJobs.some(
    (job) =>
      approvalHiringSources.has(job.sourceType) ||
      (job.sourceType === "manual" && job.confirmedLive),
  );
  const hasLeadOnlyHiringSignal = freshHiringJobs.some(
    (job) =>
      !approvalHiringSources.has(job.sourceType) &&
      !(job.sourceType === "manual" && job.confirmedLive),
  );
  const maxEvidenceAgeDays = Math.min(
    365,
    Math.max(30, Number(settings.maxEvidenceAgeDays) || 180),
  );
  const latestCompanyEvidence = company.evidence
    .filter((item) => item.entityType === "company")
    .reduce((latest, item) => {
      const timestamp = Date.parse(item.capturedAt);
      return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
    }, Number.NEGATIVE_INFINITY);
  const companyEvidenceAge = Date.now() - latestCompanyEvidence;
  const companyEvidenceCurrent =
    Number.isFinite(companyEvidenceAge) &&
    companyEvidenceAge >= -24 * 60 * 60 * 1_000 &&
    companyEvidenceAge <= maxEvidenceAgeDays * 24 * 60 * 60 * 1_000;
  const verificationAge = primary?.emailVerifiedAt
    ? Date.now() - Date.parse(primary.emailVerifiedAt)
    : Number.NaN;
  const emailCurrent =
    primary?.emailStatus === "valid" &&
    Number.isFinite(verificationAge) &&
    verificationAge >= -24 * 60 * 60 * 1_000 &&
    verificationAge <= freshnessDays * 24 * 60 * 60 * 1_000;
  const catchAllPolicy =
    settings.catchAllPolicy === "exclude" ||
    settings.catchAllPolicy === "allow_last_resort"
      ? settings.catchAllPolicy
      : "review";
  const catchAllExcluded =
    primary?.emailStatus === "accept_all" && catchAllPolicy === "exclude";
  const domain = primary?.email?.split("@")[1] || company.domain;
  const suppressed =
    isSuppressed(company.id, "company") ||
    isSuppressed(company.name, "company") ||
    Boolean(domain && isSuppressed(domain, "domain")) ||
    Boolean(
      primary &&
        (isSuppressed(primary.id, "person") ||
          isSuppressed(primary.fullName, "person") ||
          Boolean(primary.email && isSuppressed(primary.email, "email"))),
    );
  return [
    {
      id: "company_fit",
      label: "Company fit",
      state:
        excluded
          ? "blocked"
          : bayArea &&
              sizeFit &&
              technologyFit &&
              company.fitConfirmed &&
              recruitingFit
            ? "complete"
            : "needs_attention",
      detail:
        excluded
          ? `Excluded: ${company.exclusionReason?.replaceAll("_", " ")}`
          : bayArea &&
              sizeFit &&
              technologyFit &&
              company.fitConfirmed &&
              recruitingFit
            ? "Bay Area technology company within 3–1,000 employees and likely to use outside recruiting"
            : "Confirm Bay Area, technology, 3–1,000 employees, and likely need for outside recruiting",
    },
    {
      id: "hiring_now",
      label: "Hiring now",
      state:
        company.openRolesCount > 0 && currentHiringEvidence
          ? "complete"
          : "needs_attention",
      detail:
        company.openRolesCount === 0
          ? "Add current first-party, supported ATS, or confirmed manual hiring evidence"
          : currentHiringEvidence
            ? `First-party, supported ATS, or confirmed manual hiring evidence observed within ${approvalHiringAgeDays} days`
            : hasLeadOnlyHiringSignal
              ? "A lead-only hiring signal is current; confirm it on the company site, a supported ATS, or with a manual source review"
            : `Refresh a qualifying hiring source; its last observation is older than ${approvalHiringAgeDays} days`,
    },
    {
      id: "decision_maker",
      label: "Decision-maker",
      state:
        employmentCurrent ? "complete" : "needs_attention",
      detail: primary
        ? employmentCurrent
          ? `${primary.fullName} is the reviewed primary with employment confirmed within six months`
          : `Confirm ${primary.fullName}'s current title and observed date within six months`
        : "Select and review one primary decision-maker",
    },
    {
      id: "contact_route",
      label: "Contact route",
      state:
        primary?.email && fallbackDocumented ? "complete" : "needs_attention",
      detail: !primary?.email
        ? "Find one current email route"
        : fallbackDocumented
          ? `${primary.emailType} email selected`
          : "Document why this non-work route is necessary",
    },
    {
      id: "email_current",
      label: "Email current",
      state:
        primary?.emailStatus === "invalid" ||
        primary?.emailStatus === "disposable" ||
        primary?.emailStatus === "do_not_mail" ||
        catchAllExcluded
          ? "blocked"
          : emailCurrent
            ? "complete"
            : "needs_attention",
      detail: emailCurrent
        ? `Valid within ${freshnessDays} days`
        : primary?.emailStatus === "accept_all"
          ? catchAllPolicy === "exclude"
            ? "Catch-all is excluded by the configured policy"
            : catchAllPolicy === "allow_last_resort"
              ? "Catch-all retained only as a reviewed fallback lead; it is not send-ready"
              : "Catch-all requires manual review and is not send-ready"
        : "A dedicated verifier must report valid within the freshness window",
    },
    {
      id: "evidence_freshness",
      label: "Company evidence",
      state: companyEvidenceCurrent ? "complete" : "needs_attention",
      detail: companyEvidenceCurrent
        ? `Company evidence captured within ${maxEvidenceAgeDays} days`
        : `Research or confirm a company source within ${maxEvidenceAgeDays} days`,
    },
    {
      id: "conflicts",
      label: "Conflicts resolved",
      state: company.conflictCount > 0 ? "blocked" : "complete",
      detail:
        company.conflictCount > 0
          ? `${company.conflictCount} identity conflict${company.conflictCount === 1 ? "" : "s"}`
          : "No unresolved identity conflicts",
    },
    {
      id: "suppression",
      label: "Suppression",
      state: suppressed ? "blocked" : "complete",
      detail: suppressed ? "A person, address, domain, or company block applies" : "Clear",
    },
  ];
}

export function patchCompany(companyId: string, patch: Record<string, unknown>) {
  const previous = getDatabase()
    .query("SELECT normalized_name, domain FROM companies WHERE id = ?")
    .get(companyId) as {
      normalized_name: string;
      domain: string | null;
    } | null;
  const fieldMap: Record<string, string> = {
    name: "name",
    domain: "domain",
    websiteUrl: "website_url",
    linkedinUrl: "linkedin_url",
    ycUrl: "yc_url",
    description: "description",
    location: "location",
    employeeCountMin: "employee_count_min",
    employeeCountMax: "employee_count_max",
    industries: "industries_json",
    stage: "stage",
    status: "status",
    priority: "priority",
    fitConfirmed: "fit_confirmed",
    recruitingFit: "recruiting_fit",
    recruitingFitNote: "recruiting_fit_note",
    exclusionReason: "exclusion_reason",
    exclusionNote: "exclusion_note",
    notes: "notes",
    reviewed: "reviewed",
    lastResearchedAt: "last_researched_at",
  };
  const assignments: string[] = [];
  const params: SqlValue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = fieldMap[key];
    if (!column) continue;
    assignments.push(`${column} = ?`);
    if (key === "industries") params.push(JSON.stringify(value));
    else if (key === "reviewed" || key === "fitConfirmed") {
      params.push(value ? 1 : 0);
    }
    else if (key === "domain") params.push(normalizeDomain(value as string | null));
    else params.push(value as SqlValue);
  }
  const materialCompanyFields = [
    "name",
    "domain",
    "websiteUrl",
    "location",
    "employeeCountMin",
    "employeeCountMax",
    "industries",
    "fitConfirmed",
    "recruitingFit",
    "exclusionReason",
  ];
  if (
    materialCompanyFields.some((key) => Object.hasOwn(patch, key)) &&
    patch.reviewed === undefined
  ) {
    assignments.push("reviewed = 0");
    if (patch.status === undefined) {
      assignments.push(
        "status = CASE WHEN status = 'approved' THEN 'ready_for_review' ELSE status END",
      );
    }
  }
  if (!assignments.length) return getCompany(companyId);
  if (patch.name) {
    assignments.push("normalized_name = ?");
    params.push(normalizeName(String(patch.name)));
  }
  assignments.push("updated_at = ?");
  params.push(nowIso(), companyId);
  getDatabase()
    .query(`UPDATE companies SET ${assignments.join(", ")} WHERE id = ?`)
    .run(...params);
  if (
    Object.hasOwn(patch, "domain") &&
    normalizeDomain(patch.domain as string | null) !== previous?.domain
  ) {
    getDatabase()
      .query(
        `UPDATE contacts SET reviewed = 0, updated_at = ?
         WHERE company_id = ?`,
      )
      .run(nowIso(), companyId);
  }
  syncCompanySearch(companyId);
  if (previous) refreshNameConflicts(previous.normalized_name);
  const updated = getDatabase()
    .query("SELECT normalized_name FROM companies WHERE id = ?")
    .get(companyId) as { normalized_name: string } | null;
  if (updated && updated.normalized_name !== previous?.normalized_name) {
    refreshNameConflicts(updated.normalized_name);
  }
  addAudit("company.updated", "company", companyId, "Updated company record", patch);
  recomputeCompanyStats(companyId);
  return getCompany(companyId);
}

export function excludeCompany(
  companyId: string,
  reason: string,
  note?: string,
) {
  const normalizedNote = note?.trim() || reason.replaceAll("_", " ");
  patchCompany(companyId, {
    exclusionReason: reason,
    exclusionNote: note?.trim() || null,
    fitConfirmed: false,
    recruitingFit: "excluded",
    status: "rejected",
    reviewed: true,
  });
  const timestamp = nowIso();
  getDatabase()
    .query(
      `INSERT INTO reviews (id, company_id, decision, notes, created_at)
       VALUES (?, ?, 'rejected', ?, ?)`,
    )
    .run(newId(), companyId, normalizedNote, timestamp);
  addAudit(
    "company.excluded",
    "company",
    companyId,
    `Excluded company: ${reason.replaceAll("_", " ")}`,
    { note: note?.trim() || null },
  );
  return getCompany(companyId);
}

export function addManualJob(
  companyId: string,
  input: {
    title: string;
    location?: string | null;
    department?: string | null;
    url?: string | null;
    postedAt?: string | null;
    observedAt: string;
    excerpt?: string | null;
    confirmedLive: boolean;
    noPublicUrl?: boolean;
  },
) {
  if (!input.confirmedLive) {
    throw new Error("Confirm that the role or hiring evidence is currently live.");
  }
  if (!input.url && !input.noPublicUrl) {
    throw new Error("Add a public URL or confirm that no public URL is available.");
  }
  const hiringWindowDays = Math.min(
    180,
    Math.max(30, Number(getSettings().jobFreshnessDays) || 180),
  );
  assertObservationDate(
    input.observedAt,
    "Hiring observation date",
    hiringWindowDays,
  );
  if (input.postedAt) {
    assertObservationDate(input.postedAt, "Job posting date");
  }
  const result = upsertJob({
    companyId,
    externalId: input.url || `manual:${input.title}:${input.observedAt}`,
    title: input.title,
    location: input.location ?? null,
    department: input.department ?? null,
    descriptionExcerpt: input.excerpt ?? null,
    url: input.url ?? null,
    sourceType: "manual",
    postedAt: input.postedAt ?? null,
    observedAt: input.observedAt,
    confirmedLive: true,
  });
  addEvidence({
    entityType: "job",
    entityId: result.id,
    fieldName: "hiring",
    value: input.title,
    sourceType: "manual",
    sourceLabel: "Manually confirmed live hiring",
    sourceUrl: input.url ?? null,
    excerpt: input.excerpt ?? null,
    confidence: 0.9,
    payload: {
      companyId,
      observedAt: input.observedAt,
      noPublicUrl: Boolean(input.noPublicUrl),
    },
  });
  addAudit(
    "job.manual_added",
    "company",
    companyId,
    `Confirmed live hiring: ${input.title}`,
    { jobId: result.id, sourceUrl: input.url ?? null },
  );
  return getCompany(companyId);
}

export function resolveConflict(
  conflictId: string,
  resolution: "use_candidate" | "keep_current" | "research_further",
  note: string,
) {
  const normalizedNote = note.trim();
  if (!normalizedNote) throw new Error("A resolution note is required.");
  const database = getDatabase();
  const conflict = database
    .query("SELECT * FROM conflicts WHERE id = ?")
    .get(conflictId) as Record<string, unknown> | null;
  if (!conflict) throw new Error("Conflict not found.");
  if (conflict.status === "resolved") {
    throw new Error("This conflict was already resolved.");
  }
  const companyId = String(conflict.company_id);
  if (resolution === "use_candidate") {
    const value = (conflict.candidate_value as string | null) ?? null;
    const field = String(conflict.field_name);
    if (conflict.entity_type === "company") {
      if (field === "employee_count") {
        const values = String(value || "")
          .match(/\d[\d,]*/g)
          ?.map((item) => Number(item.replaceAll(",", "")));
        if (!values?.length) {
          throw new Error("The candidate employee range could not be parsed.");
        }
        patchCompany(companyId, {
          employeeCountMin: Math.min(...values),
          employeeCountMax: Math.max(...values),
          reviewed: false,
        });
      } else if (field === "industries") {
        patchCompany(companyId, {
          industries: String(value || "")
            .split(/[,;|]/)
            .map((item) => item.trim())
            .filter(Boolean),
          reviewed: false,
        });
      } else {
        const fieldMap: Record<string, string> = {
          name: "name",
          domain: "domain",
          location: "location",
          stage: "stage",
        };
        const patchField = fieldMap[field];
        if (!patchField) throw new Error("This conflict cannot be applied automatically.");
        patchCompany(companyId, { [patchField]: value, reviewed: false });
      }
    } else if (conflict.entity_type === "contact") {
      const contactId = String(conflict.entity_id);
      if (field === "phone") {
        patchContact(contactId, {
          phone: value,
          phoneConfirmed: true,
          phoneSource: `Conflict resolution: ${normalizedNote}`,
          reviewed: false,
        });
      } else if (field === "email" || field === "title") {
        patchContact(contactId, { [field]: value, reviewed: false });
      } else {
        throw new Error("This conflict cannot be applied automatically.");
      }
    }
  }
  const timestamp = nowIso();
  if (resolution === "research_further") {
    database
      .query(
        `UPDATE conflicts SET status = 'researching', resolution = ?,
          resolution_note = ?, resolved_at = NULL
         WHERE id = ?`,
      )
      .run(resolution, normalizedNote, conflictId);
    database
      .query(
        `UPDATE companies SET status = 'needs_research', reviewed = 0,
          updated_at = ? WHERE id = ?`,
      )
      .run(timestamp, companyId);
  } else {
    database
      .query(
        `UPDATE conflicts SET status = 'resolved', resolution = ?,
          resolution_note = ?, resolved_at = ?
         WHERE id = ?`,
      )
      .run(resolution, normalizedNote, timestamp, conflictId);
  }
  recomputeConflictCount(companyId);
  addAudit(
    "conflict.resolved",
    "company",
    companyId,
    resolution === "research_further"
      ? `Flagged ${String(conflict.field_name)} for more research`
      : `Resolved ${String(conflict.field_name)} conflict`,
    { conflictId, resolution, note: normalizedNote },
  );
  return getCompany(companyId);
}

export function deactivateMissingJobs(
  companyId: string,
  sourceType: string,
  externalIds: string[],
) {
  const database = getDatabase();
  let changes = 0;
  if (!externalIds.length) {
    changes = database
      .query(
        `UPDATE jobs SET active = 0
         WHERE company_id = ? AND source_type = ? AND active = 1`,
      )
      .run(companyId, sourceType).changes;
  } else {
    const placeholders = externalIds.map(() => "?").join(", ");
    changes = database
      .query(
        `UPDATE jobs SET active = 0
         WHERE company_id = ? AND source_type = ? AND active = 1
           AND external_id NOT IN (${placeholders})`,
      )
      .run(companyId, sourceType, ...externalIds).changes;
  }
  recomputeCompanyStats(companyId);
  if (changes) reopenCompanyReview(companyId, "Published hiring roles closed.");
}

export function addContact(companyId: string, input: Record<string, unknown>) {
  const db = getDatabase();
  const email = (input.email as string | null)?.toLowerCase() ?? null;
  const linkedinUrl = (input.linkedinUrl as string | null) ?? null;
  const fullName = String(input.fullName || "").trim();
  const employmentObservedTitle =
    (input.observedTitle as string | null) ??
    (input.title as string | null) ??
    null;
  if (
    input.phone &&
    (input.phoneConfirmed !== true ||
      !String(input.phoneSource || "").trim())
  ) {
    throw new Error(
      "A manually added phone requires confirmation and a source URL or note.",
    );
  }
  if (
    input.employmentConfirmed &&
    (!String(employmentObservedTitle || "").trim() ||
      !String(input.employmentObservedAt || "").trim())
  ) {
    throw new Error(
      "Current employment confirmation requires an observed title and observed date.",
    );
  }
  if (input.employmentObservedAt) {
    assertObservationDate(
      input.employmentObservedAt,
      "Employment observation date",
    );
  }
  const existing = db
    .query(
      `SELECT id FROM contacts
       WHERE company_id = ?
         AND (
           (? IS NOT NULL AND email = ?)
           OR (? IS NOT NULL AND linkedin_url = ?)
           OR (lower(full_name) = lower(?) AND COALESCE(title, '') = COALESCE(?, ''))
         )
       LIMIT 1`,
    )
    .get(
      companyId,
      email,
      email,
      linkedinUrl,
      linkedinUrl,
      fullName,
      (input.title as string | null) ?? null,
    ) as { id: string } | null;
  if (existing) {
    return patchContact(existing.id, {
      ...input,
      fullName,
      email,
      linkedinUrl,
    });
  }
  const id = newId();
  const timestamp = nowIso();
  if (input.status === "primary") {
    db.query(
      `UPDATE contacts SET status = 'alternate', updated_at = ?
       WHERE company_id = ? AND status = 'primary'`,
    ).run(timestamp, companyId);
  }
  db
    .query(
      `INSERT INTO contacts (
        id, company_id, first_name, last_name, full_name, title, role_category,
        email, email_type, fallback_reason, fallback_confirmed, email_status,
        email_verified_at, phone, phone_type, phone_confirmed, phone_source,
        linkedin_url, employment_confirmed, observed_title,
        employment_observed_at, rank, status, reviewed, notes, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      companyId,
      (input.firstName as string | null) ?? null,
      (input.lastName as string | null) ?? null,
      fullName,
      (input.title as string | null) ?? null,
      (input.roleCategory as string | null) ?? null,
      email,
      (input.emailType as string) ?? "unknown",
      (input.fallbackReason as string | null) ?? null,
      input.fallbackConfirmed ? 1 : 0,
      (input.emailStatus as string) ?? "unverified",
      (input.emailVerifiedAt as string | null) ?? null,
      (input.phone as string | null) ?? null,
      (input.phoneType as string) ?? "unknown",
      input.phoneConfirmed ? 1 : 0,
      (input.phoneSource as string | null) ?? null,
      linkedinUrl,
      input.employmentConfirmed ? 1 : 0,
      employmentObservedTitle,
      (input.employmentObservedAt as string | null) ?? null,
      (input.rank as number) ?? 1,
      (input.status as string) ?? "candidate",
      input.reviewed ? 1 : 0,
      (input.notes as string | null) ?? null,
      timestamp,
      timestamp,
    );
  if (input.status === "primary") {
    reopenCompanyReview(companyId, "Primary decision-maker changed.");
  }
  addAudit("contact.created", "contact", id, `Added ${fullName}`, { companyId });
  if (input.employmentConfirmed) {
    addEvidence({
      entityType: "contact",
      entityId: id,
      fieldName: "employment_confirmation",
      value: String(employmentObservedTitle || ""),
      sourceType: "manual",
      sourceLabel: "Manually confirmed current employment",
      sourceUrl: linkedinUrl,
      confidence: 0.9,
      payload: { observedAt: input.employmentObservedAt },
    });
  }
  recomputeCompanyStats(companyId);
  return getContact(id);
}

export function getContact(contactId: string) {
  const row = getDatabase()
    .query("SELECT * FROM contacts WHERE id = ?")
    .get(contactId) as Record<string, unknown> | null;
  return row ? mapContact(row) : null;
}

export function patchContact(contactId: string, patch: Record<string, unknown>) {
  const database = getDatabase();
  const before = database
    .query(
      `SELECT company_id, email, phone_source, phone_confirmed,
        employment_confirmed, observed_title, employment_observed_at
       FROM contacts WHERE id = ?`,
    )
    .get(contactId) as {
      company_id: string;
      email: string | null;
      phone_source: string | null;
      phone_confirmed: number;
      employment_confirmed: number;
      observed_title: string | null;
      employment_observed_at: string | null;
    } | null;
  if (patch.phone) {
    const confirmed =
      patch.phoneConfirmed === true ||
      (patch.phoneConfirmed === undefined && Boolean(before?.phone_confirmed));
    const source =
      patch.phoneSource === undefined ? before?.phone_source : patch.phoneSource;
    if (!confirmed || !String(source || "").trim()) {
      throw new Error(
        "A manually added phone requires confirmation and a source URL or note.",
      );
    }
  }
  const effectiveEmploymentConfirmed =
    patch.employmentConfirmed === undefined
      ? Boolean(before?.employment_confirmed)
      : patch.employmentConfirmed === true;
  if (
    effectiveEmploymentConfirmed &&
    ["employmentConfirmed", "observedTitle", "employmentObservedAt"].some(
      (key) => Object.hasOwn(patch, key),
    )
  ) {
    const observedTitle =
      patch.observedTitle === undefined
        ? before?.observed_title
        : patch.observedTitle;
    const observedAt =
      patch.employmentObservedAt === undefined
        ? before?.employment_observed_at
        : patch.employmentObservedAt;
    if (!String(observedTitle || "").trim() || !String(observedAt || "").trim()) {
      throw new Error(
        "Current employment confirmation requires an observed title and observed date.",
      );
    }
  }
  if (patch.employmentObservedAt) {
    assertObservationDate(
      patch.employmentObservedAt,
      "Employment observation date",
    );
  }
  const fieldMap: Record<string, string> = {
    firstName: "first_name",
    lastName: "last_name",
    fullName: "full_name",
    title: "title",
    roleCategory: "role_category",
    email: "email",
    emailType: "email_type",
    fallbackReason: "fallback_reason",
    fallbackConfirmed: "fallback_confirmed",
    emailStatus: "email_status",
    emailVerifiedAt: "email_verified_at",
    phone: "phone",
    phoneType: "phone_type",
    phoneConfirmed: "phone_confirmed",
    phoneSource: "phone_source",
    linkedinUrl: "linkedin_url",
    employmentConfirmed: "employment_confirmed",
    observedTitle: "observed_title",
    employmentObservedAt: "employment_observed_at",
    rank: "rank",
    status: "status",
    reviewed: "reviewed",
    notes: "notes",
  };
  const assignments: string[] = [];
  const params: SqlValue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = fieldMap[key];
    if (!column) continue;
    assignments.push(`${column} = ?`);
    if (
      key === "reviewed" ||
      key === "phoneConfirmed" ||
      key === "fallbackConfirmed" ||
      key === "employmentConfirmed"
    ) {
      params.push(value ? 1 : 0);
    }
    else if (key === "email") params.push(value ? String(value).toLowerCase() : null);
    else params.push(value as SqlValue);
  }
  const emailChanged = Object.hasOwn(patch, "email");
  if (emailChanged && patch.emailStatus === undefined) {
    assignments.push("email_status = 'unverified'");
  }
  if (emailChanged && patch.emailVerifiedAt === undefined) {
    assignments.push("email_verified_at = NULL");
  }
  const materialContactFields = [
    "fullName",
    "title",
    "email",
    "emailType",
    "linkedinUrl",
    "employmentConfirmed",
    "observedTitle",
    "employmentObservedAt",
  ];
  if (
    materialContactFields.some((key) => Object.hasOwn(patch, key)) &&
    patch.reviewed === undefined
  ) {
    assignments.push("reviewed = 0");
  }
  if (!assignments.length) return getContact(contactId);
  assignments.push("updated_at = ?");
  params.push(nowIso(), contactId);
  if (before && patch.status === "primary") {
    database
      .query(
        `UPDATE contacts SET status = 'alternate', updated_at = ?
         WHERE company_id = ? AND id != ? AND status = 'primary'`,
      )
      .run(nowIso(), before.company_id, contactId);
    reopenCompanyReview(before.company_id, "Primary decision-maker changed.");
  }
  database
    .query(`UPDATE contacts SET ${assignments.join(", ")} WHERE id = ?`)
    .run(...params);
  const after = getContact(contactId);
  if (after?.status === "suppressed" && after.email) {
    addSuppression(
      after.email,
      "email",
      after.notes || "Owner marked this contact suppressed.",
    );
  }
  if (
    after?.employmentConfirmed &&
    ["employmentConfirmed", "observedTitle", "employmentObservedAt", "linkedinUrl"].some(
      (key) => Object.hasOwn(patch, key),
    )
  ) {
    addEvidence({
      entityType: "contact",
      entityId: contactId,
      fieldName: "employment_confirmation",
      value: after.observedTitle || after.title,
      sourceType: "manual",
      sourceLabel: "Manually confirmed current employment",
      sourceUrl: after.linkedinUrl,
      confidence: 0.9,
      payload: { observedAt: after.employmentObservedAt },
    });
  }
  addAudit("contact.updated", "contact", contactId, "Updated contact record", patch);
  if (before) recomputeCompanyStats(before.company_id);
  return after;
}

export function recordReview(
  companyId: string,
  decision: "approved" | "rejected" | "needs_research",
  notes?: string,
) {
  const current = getCompany(companyId);
  if (!current) throw new Error("Company not found.");
  if (decision === "approved") {
    const required = new Set([
      "company_fit",
      "hiring_now",
      "evidence_freshness",
      "conflicts",
      "suppression",
    ]);
    const issues = current.readiness.filter(
      (item) => required.has(item.id) && item.state !== "complete",
    );
    if (issues.length) {
      throw new Error(
        `Complete company qualification first: ${issues
          .map((item) => item.label)
          .join(", ")}.`,
      );
    }
  } else if (!notes?.trim()) {
    throw new Error(
      decision === "rejected"
        ? "Add a rejection reason before completing review."
        : "Add a note describing the remaining research.",
    );
  }
  const timestamp = nowIso();
  const status =
    decision === "approved"
      ? "approved"
      : decision === "rejected"
        ? "rejected"
        : "needs_research";
  getDatabase().transaction(() => {
    getDatabase()
      .query(
        `UPDATE companies SET reviewed = 1, status = ?, notes = COALESCE(?, notes),
         updated_at = ? WHERE id = ?`,
      )
      .run(status, notes ?? null, timestamp, companyId);
    getDatabase()
      .query(
        `INSERT INTO reviews (id, company_id, decision, notes, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(newId(), companyId, decision, notes ?? null, timestamp);
  })();
  addAudit("company.reviewed", "company", companyId, `Review: ${decision}`, {
    notes,
  });
  return getCompany(companyId);
}

export function getDashboardSummary(): DashboardSummary {
  const row = getDatabase()
    .query(
      `SELECT
        (SELECT COUNT(*) FROM companies) AS companies,
        (SELECT COUNT(*) FROM companies WHERE reviewed = 0) AS needs_review,
        (SELECT COUNT(*) FROM companies WHERE status = 'approved') AS approved,
        (SELECT COUNT(*) FROM companies WHERE reviewed = 1) AS reviewed,
        (SELECT COUNT(*) FROM contacts) AS contacts,
        (SELECT COUNT(*) FROM contacts WHERE email_status = 'valid') AS valid_emails,
        (SELECT COALESCE(SUM(open_roles_count), 0) FROM companies) AS open_roles,
        (SELECT COALESCE(SUM(conflict_count), 0) FROM companies) AS conflicts`,
    )
    .get() as Record<string, number>;
  return {
    companies: Number(row.companies),
    needsReview: Number(row.needs_review),
    approved: Number(row.approved),
    reviewed: Number(row.reviewed),
    contacts: Number(row.contacts),
    validEmails: Number(row.valid_emails),
    openRoles: Number(row.open_roles),
    conflicts: Number(row.conflicts),
  };
}

export function createSourceRun(sourceType: string, params: unknown) {
  const normalizedParams = canonicalJson(params);
  const paramsHash = createHash("sha256")
    .update(`${sourceType}:${normalizedParams}`)
    .digest("hex");
  const existing = getDatabase()
    .query(
      `SELECT id FROM source_runs
       WHERE source_type = ? AND params_hash = ?
         AND status IN ('queued', 'running')
       LIMIT 1`,
    )
    .get(sourceType, paramsHash) as { id: string } | null;
  if (existing) return { id: existing.id, created: false };
  const id = newId();
  const timestamp = nowIso();
  getDatabase()
    .query(
      `INSERT INTO source_runs
       (id, source_type, status, params_json, params_hash, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
    )
    .run(id, sourceType, normalizedParams, paramsHash, timestamp);
  return { id, created: true };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalJson(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function startSourceRun(id: string) {
  getDatabase()
    .query(
      `UPDATE source_runs SET status = 'running', started_at = ?
       WHERE id = ? AND status = 'queued'`,
    )
    .run(nowIso(), id);
}

export function finishSourceRun(
  id: string,
  result: {
    inserted: number;
    updated: number;
    skipped: number;
    error?: string;
  },
) {
  getDatabase()
    .query(
      `UPDATE source_runs SET
        status = ?, inserted_count = ?, updated_count = ?, skipped_count = ?,
        error_message = ?, finished_at = ?
       WHERE id = ?`,
    )
    .run(
      result.error ? "failed" : "completed",
      result.inserted,
      result.updated,
      result.skipped,
      result.error ?? null,
      nowIso(),
      id,
    );
}

export function listSourceRuns(limit = 25): SourceRunItem[] {
  return (
    getDatabase()
      .query("SELECT * FROM source_runs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[]
  ).map((row) => ({
    id: String(row.id),
    sourceType: String(row.source_type),
    status: row.status as SourceRunItem["status"],
    insertedCount: Number(row.inserted_count),
    updatedCount: Number(row.updated_count),
    skippedCount: Number(row.skipped_count),
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: String(row.created_at),
    finishedAt: (row.finished_at as string | null) ?? null,
  }));
}

export function saveSetting(key: string, value: unknown) {
  getDatabase()
    .query(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), nowIso());
}

export function getSettings(): Record<string, unknown> {
  const rows = getDatabase().query("SELECT key, value_json FROM settings").all() as {
    key: string;
    value_json: string;
  }[];
  return Object.fromEntries(
    rows.map((row) => [row.key, safeJsonParse<unknown>(row.value_json, null)]),
  );
}

export function createOrUpdateDraft(input: {
  companyId: string;
  contactId: string;
  subject: string;
  body: string;
}) {
  const db = getDatabase();
  const ambiguous = db
    .query(
      `SELECT id FROM outreach_drafts
       WHERE company_id = ? AND contact_id = ?
         AND status IN ('sending', 'send_unknown')
       LIMIT 1`,
    )
    .get(input.companyId, input.contactId) as { id: string } | null;
  if (ambiguous) {
    throw new Error(
      "This contact has a delivery whose result is unresolved. Check Gmail before creating another message.",
    );
  }
  const existing = db
    .query(
      `SELECT id FROM outreach_drafts
       WHERE company_id = ? AND contact_id = ? AND status IN ('draft', 'approved')
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(input.companyId, input.contactId) as { id: string } | null;
  const timestamp = nowIso();
  if (existing) {
    db.query(
      `UPDATE outreach_drafts
       SET subject = ?, body = ?, edited_at = NULL, status = 'draft', updated_at = ?
       WHERE id = ?`,
    ).run(input.subject, input.body, timestamp, existing.id);
    return getDraft(existing.id);
  }
  const id = newId();
  db.query(
    `INSERT INTO outreach_drafts (
      id, company_id, contact_id, subject, body, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
  ).run(
    id,
    input.companyId,
    input.contactId,
    input.subject,
    input.body,
    timestamp,
    timestamp,
  );
  addAudit("outreach.draft_created", "company", input.companyId, "Created outreach draft", {
    contactId: input.contactId,
  });
  return getDraft(id);
}

function mapDraft(row: Record<string, unknown>): OutreachDraft {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    companyName: String(row.company_name),
    contactId: String(row.contact_id),
    contactName: String(row.contact_name),
    contactEmail: (row.contact_email as string | null) ?? null,
    subject: String(row.subject),
    body: String(row.body),
    editedAt: (row.edited_at as string | null) ?? null,
    status: row.status as OutreachDraft["status"],
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    sentAt: (row.sent_at as string | null) ?? null,
    outcomeAt: (row.outcome_at as string | null) ?? null,
    outcomeNote: (row.outcome_note as string | null) ?? null,
    updatedAt: String(row.updated_at),
  };
}

export function getDraft(draftId: string) {
  const row = getDatabase()
    .query(
      `SELECT d.*, c.name AS company_name, ct.full_name AS contact_name,
        ct.email AS contact_email
       FROM outreach_drafts d
       JOIN companies c ON c.id = d.company_id
       JOIN contacts ct ON ct.id = d.contact_id
       WHERE d.id = ?`,
    )
    .get(draftId) as Record<string, unknown> | null;
  return row ? mapDraft(row) : null;
}

export function listDrafts(input?: {
  view?: "active" | "approved" | "all";
  limit?: number;
  offset?: number;
}) {
  const view = input?.view || "all";
  const where =
    view === "active"
      ? "WHERE d.status IN ('draft', 'approved', 'sending', 'send_unknown')"
      : view === "approved"
        ? "WHERE d.status = 'approved'"
        : "";
  const paging = input ? "LIMIT ? OFFSET ?" : "";
  const parameters = input
    ? [
        Math.min(500, Math.max(1, input.limit || 100)),
        Math.max(0, input.offset || 0),
      ]
    : [];
  return (
    getDatabase()
      .query(
        `SELECT d.*, c.name AS company_name, ct.full_name AS contact_name,
          ct.email AS contact_email
         FROM outreach_drafts d
         JOIN companies c ON c.id = d.company_id
         JOIN contacts ct ON ct.id = d.contact_id
         ${where}
         ORDER BY d.updated_at DESC
         ${paging}`,
      )
      .all(...parameters) as Record<string, unknown>[]
  ).map(mapDraft);
}

export function countDrafts(view: "active" | "approved" | "all" = "all") {
  const where =
    view === "active"
      ? "WHERE status IN ('draft', 'approved', 'sending', 'send_unknown')"
      : view === "approved"
        ? "WHERE status = 'approved'"
        : "";
  const row = getDatabase()
    .query(`SELECT COUNT(*) AS count FROM outreach_drafts ${where}`)
    .get() as { count: number };
  return Number(row.count);
}

export function listCompanyOutreach(companyId: string) {
  return (
    getDatabase()
      .query(
        `SELECT d.*, c.name AS company_name, ct.full_name AS contact_name,
          ct.email AS contact_email
         FROM outreach_drafts d
         JOIN companies c ON c.id = d.company_id
         JOIN contacts ct ON ct.id = d.contact_id
         WHERE d.company_id = ?
         ORDER BY d.updated_at DESC`,
      )
      .all(companyId) as Record<string, unknown>[]
  ).map(mapDraft);
}

export function patchDraft(draftId: string, input: Record<string, unknown>) {
  const current = getDraft(draftId);
  if (!current) return null;
  if (!["draft", "approved"].includes(current.status)) {
    throw new Error("Sent and unresolved delivery records are immutable history.");
  }
  const allowed: Record<string, string> = {
    subject: "subject",
    body: "body",
    status: "status",
    scheduledAt: "scheduled_at",
  };
  const assignments: string[] = [];
  const params: SqlValue[] = [];
  const contentChanged =
    (Object.hasOwn(input, "subject") && input.subject !== current.subject) ||
    (Object.hasOwn(input, "body") && input.body !== current.body);
  const proposedBody =
    typeof input.body === "string" ? input.body : current.body;
  if (input.status === "approved" && /\[your name\]/i.test(proposedBody)) {
    throw new Error("Replace the [Your name] placeholder before approving this message.");
  }
  for (const [key, value] of Object.entries(input)) {
    if (!allowed[key]) continue;
    assignments.push(`${allowed[key]} = ?`);
    params.push(value as SqlValue);
  }
  if (input.status === "approved" && !current.editedAt && !contentChanged) {
    throw new Error("Edit this generated message before approving it.");
  }
  if (contentChanged) {
    assignments.push("edited_at = ?");
    params.push(nowIso());
    if (input.status === undefined) {
      assignments.push("status = 'draft'");
    }
  }
  if (!assignments.length) return getDraft(draftId);
  assignments.push("updated_at = ?");
  params.push(nowIso(), draftId);
  getDatabase()
    .query(`UPDATE outreach_drafts SET ${assignments.join(", ")} WHERE id = ?`)
    .run(...params);
  const updated = getDraft(draftId);
  addAudit(
    "outreach.draft_updated",
    "company",
    current.companyId,
    input.status === "approved"
      ? "Approved manually edited outreach draft"
      : contentChanged
        ? "Manually edited outreach draft"
        : "Updated outreach draft state",
    {
      draftId,
      changedFields: Object.keys(input),
      status: updated?.status,
    },
  );
  return updated;
}

function zonedDateKey(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function getOutreachRateCounts(timeZone?: string) {
  const row = getDatabase()
    .query(
      `SELECT
        SUM(CASE
          WHEN datetime(sent_at) >= datetime('now', '-1 hour') THEN 1
          ELSE 0
        END) AS sent_last_hour
       FROM outreach_drafts
       WHERE status IN ('sent', 'replied', 'bounced') AND sent_at IS NOT NULL`,
    )
    .get() as { sent_last_hour: number | null };
  const sentToday = timeZone
    ? (
        getDatabase()
          .query(
            `SELECT sent_at FROM outreach_drafts
             WHERE status IN ('sent', 'replied', 'bounced')
               AND sent_at IS NOT NULL
               AND datetime(sent_at) >= datetime('now', '-2 days')`,
          )
          .all() as Array<{ sent_at: string }>
      ).filter(
        (item) =>
          zonedDateKey(new Date(item.sent_at), timeZone) ===
          zonedDateKey(new Date(), timeZone),
      ).length
    : Number(
        (
          getDatabase()
            .query(
              `SELECT COUNT(*) AS count FROM outreach_drafts
               WHERE status IN ('sent', 'replied', 'bounced')
                 AND sent_at IS NOT NULL
                 AND date(sent_at, 'localtime') = date('now', 'localtime')`,
            )
            .get() as { count: number }
        ).count,
      );
  return {
    sentLastHour: Number(row.sent_last_hour || 0),
    sentToday,
  };
}

export function claimDraftForSend(draftId: string) {
  const result = getDatabase()
    .query(
      `UPDATE outreach_drafts
       SET status = 'sending', updated_at = ?
       WHERE id = ? AND status = 'approved'`,
    )
    .run(nowIso(), draftId);
  return result.changes === 1 ? getDraft(draftId) : null;
}

export function releaseDraftAfterSendFailure(draftId: string, message: string) {
  getDatabase()
    .query(
      `UPDATE outreach_drafts
       SET status = 'approved', updated_at = ?
       WHERE id = ? AND status = 'sending'`,
    )
    .run(nowIso(), draftId);
  const draft = getDraft(draftId);
  if (draft) {
    addAudit(
      "outreach.send_failed",
      "company",
      draft.companyId,
      "Gmail send failed",
      { draftId, message },
    );
  }
  return draft;
}

export function markDraftSendUnknown(draftId: string, message: string) {
  getDatabase()
    .query(
      `UPDATE outreach_drafts
       SET status = 'send_unknown', updated_at = ?
       WHERE id = ? AND status = 'sending'`,
    )
    .run(nowIso(), draftId);
  const draft = getDraft(draftId);
  if (draft) {
    addAudit(
      "outreach.send_unknown",
      "company",
      draft.companyId,
      "Gmail delivery result requires manual inspection",
      { draftId, message },
    );
  }
  return draft;
}

export function markDraftSent(
  draftId: string,
  gmailMessageId: string,
  gmailThreadId?: string | null,
) {
  const timestamp = nowIso();
  getDatabase()
    .query(
      `UPDATE outreach_drafts
       SET status = 'sent', sent_at = ?, gmail_message_id = ?,
           gmail_thread_id = ?, updated_at = ?
       WHERE id = ? AND status = 'sending'`,
    )
    .run(
      timestamp,
      gmailMessageId,
      gmailThreadId ?? null,
      timestamp,
      draftId,
    );
  const draft = getDraft(draftId);
  if (draft) {
    addAudit(
      "outreach.sent",
      "company",
      draft.companyId,
      `Sent reviewed outreach to ${draft.contactName}`,
      { draftId, gmailMessageId, gmailThreadId },
    );
  }
  return draft;
}

export function recordDraftOutcome(
  draftId: string,
  outcome: "replied" | "bounced" | "no_response",
  note?: string,
) {
  const draft = getDraft(draftId);
  if (!draft) throw new Error("Draft not found.");
  if (draft.status !== "sent") {
    throw new Error("Only a sent message can receive an outreach outcome.");
  }
  if (outcome === "no_response") {
    const settings = getSettings();
    const waitDays = Math.min(
      90,
      Math.max(1, Number(settings.no_response_wait_days) || 7),
    );
    const sentAt = draft.sentAt ? Date.parse(draft.sentAt) : Number.NaN;
    if (
      !Number.isFinite(sentAt) ||
      Date.now() - sentAt < waitDays * 24 * 60 * 60 * 1_000
    ) {
      throw new Error(
        `Wait ${waitDays} days after sending before marking no response.`,
      );
    }
  }
  const timestamp = nowIso();
  getDatabase()
    .query(
      `UPDATE outreach_drafts
       SET status = ?, outcome_at = ?, outcome_note = ?, updated_at = ?
       WHERE id = ? AND status = 'sent'`,
    )
    .run(outcome, timestamp, note?.trim() || null, timestamp, draftId);
  if (outcome === "bounced" && draft.contactEmail) {
    patchContact(draft.contactId, {
      emailStatus: "invalid",
      status: "invalid",
      notes: note?.trim() || "Email bounced.",
    });
    addSuppression(
      draft.contactEmail,
      "email",
      note?.trim() || "Gmail delivery bounced.",
    );
    const settings = getSettings();
    if (settings.bounce_pause_enabled !== false) {
      const threshold = Math.min(
        20,
        Math.max(1, Number(settings.bounce_threshold) || 3),
      );
      const row = getDatabase()
        .query(
          `SELECT COUNT(*) AS count FROM outreach_drafts
           WHERE status = 'bounced'
             AND datetime(outcome_at) >= datetime('now', '-7 days')`,
        )
        .get() as { count: number };
      if (Number(row.count) >= threshold) {
        saveSetting("gmail_sending_enabled", false);
        addAudit(
          "outreach.sending_paused",
          "company",
          draft.companyId,
          `Paused sending after ${Number(row.count)} bounces in seven days`,
          { threshold },
        );
      }
    }
  }
  addAudit(
    `outreach.${outcome}`,
    "company",
    draft.companyId,
    `Marked outreach ${outcome.replace("_", " ")}`,
    { draftId, note: note?.trim() || null },
  );
  return getDraft(draftId);
}

export function isSuppressed(
  value: string,
  kind: "email" | "domain" | "person" | "company",
) {
  const row = getDatabase()
    .query(
      `SELECT 1 AS found FROM suppression_entries
       WHERE lower(value) = lower(?) AND kind = ? LIMIT 1`,
    )
    .get(value, kind) as { found: number } | null;
  return Boolean(row);
}

export function addSuppression(
  value: string,
  kind: "email" | "domain" | "person" | "company",
  reason: string,
) {
  const normalizedValue =
    kind === "email" || kind === "domain" ? value.trim().toLowerCase() : value.trim();
  if (!normalizedValue) throw new Error("Suppression value is required.");
  getDatabase()
    .query(
      `INSERT INTO suppression_entries (id, value, kind, reason, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(value, kind) DO UPDATE SET reason = excluded.reason`,
    )
    .run(newId(), normalizedValue, kind, reason.trim(), nowIso());
  addAudit(
    "suppression.added",
    kind,
    normalizedValue,
    `Suppressed ${kind}`,
    { reason },
  );
  return { value: normalizedValue, kind, reason: reason.trim() };
}

export function listSuppressions() {
  return (
    getDatabase()
      .query(
        `SELECT id, value, kind, reason, created_at
         FROM suppression_entries ORDER BY created_at DESC`,
      )
      .all() as Array<{
      id: string;
      value: string;
      kind: string;
      reason: string;
      created_at: string;
    }>
  ).map((row) => ({
    id: row.id,
    value: row.value,
    kind: row.kind,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

export function exportRows() {
  const jobFreshnessDays = Math.min(
    180,
    Math.max(30, Number(getSettings().jobFreshnessDays) || 180),
  );
  const jobWindow = `-${jobFreshnessDays} days`;
  return getDatabase()
    .query(
      `SELECT
        c.id AS company_id,
        c.name AS company_name,
        c.domain,
        c.website_url,
        c.location,
        c.employee_count_min,
        c.employee_count_max,
        c.industries_json,
        c.stage,
        c.description AS company_description,
        c.fit_confirmed,
        c.recruiting_fit,
        c.recruiting_fit_note,
        c.exclusion_reason,
        c.exclusion_note,
        c.hiring_score,
        json_extract(c.hiring_score_json, '$.liveHiring') AS hiring_live_score,
        json_extract(c.hiring_score_json, '$.freshness') AS hiring_freshness_score,
        json_extract(c.hiring_score_json, '$.companyFit') AS company_fit_score,
        json_extract(c.hiring_score_json, '$.externalHelpFit') AS external_help_score,
        json_extract(c.hiring_score_json, '$.evidenceQuality') AS evidence_quality_score,
        c.open_roles_count,
        c.fresh_roles_count,
        c.conflict_count,
        (SELECT group_concat(j.title, '; ')
          FROM jobs j
          WHERE j.company_id = c.id AND j.active = 1
            AND datetime(CASE WHEN j.source_type = 'manual'
              THEN COALESCE(j.observed_at, j.last_seen_at)
              ELSE j.last_seen_at END) >= datetime('now', ?)
        ) AS open_role_titles,
        (SELECT group_concat(j.url, '; ')
          FROM jobs j
          WHERE j.company_id = c.id AND j.active = 1
            AND datetime(CASE WHEN j.source_type = 'manual'
              THEN COALESCE(j.observed_at, j.last_seen_at)
              ELSE j.last_seen_at END) >= datetime('now', ?)
        ) AS open_role_urls,
        (SELECT MAX(j.last_seen_at) FROM jobs j
          WHERE j.company_id = c.id AND j.active = 1
            AND datetime(CASE WHEN j.source_type = 'manual'
              THEN COALESCE(j.observed_at, j.last_seen_at)
              ELSE j.last_seen_at END) >= datetime('now', ?))
          AS latest_job_seen_at,
        c.priority,
        c.status AS company_status,
        c.reviewed AS company_reviewed,
        c.linkedin_url AS company_linkedin_url,
        c.yc_url,
        c.notes AS company_notes,
        c.last_researched_at,
        EXISTS(
          SELECT 1 FROM suppression_entries s
          WHERE (s.kind = 'company' AND lower(s.value) IN (lower(c.id), lower(c.name)))
             OR (s.kind = 'domain' AND c.domain IS NOT NULL
               AND lower(s.value) = lower(c.domain))
        ) AS company_suppressed,
        ct.id AS contact_id,
        ct.full_name,
        ct.title,
        ct.role_category,
        ct.email,
        ct.email_type,
        ct.fallback_reason,
        ct.fallback_confirmed,
        ct.email_status,
        ct.email_verified_at,
        ct.phone,
        ct.phone_type,
        ct.phone_confirmed,
        ct.phone_source,
        ct.linkedin_url AS contact_linkedin_url,
        ct.employment_confirmed,
        ct.observed_title,
        ct.employment_observed_at,
        ct.rank AS contact_rank,
        ct.status AS contact_status,
        ct.reviewed AS contact_reviewed,
        ct.notes AS contact_notes,
        EXISTS(
          SELECT 1 FROM suppression_entries s
          WHERE (s.kind = 'person' AND lower(s.value) IN (lower(ct.id), lower(ct.full_name)))
             OR (s.kind = 'email' AND ct.email IS NOT NULL
               AND lower(s.value) = lower(ct.email))
        ) AS contact_suppressed,
        (SELECT group_concat(source_label, '; ')
          FROM (
            SELECT DISTINCT e.source_label AS source_label
            FROM evidence e
            WHERE (e.entity_type = 'company' AND e.entity_id = c.id)
               OR (e.entity_type = 'contact' AND e.entity_id = ct.id)
            ORDER BY e.source_label
          )
        ) AS source_labels,
        (SELECT COUNT(*)
          FROM evidence e
          WHERE (e.entity_type = 'company' AND e.entity_id = c.id)
             OR (e.entity_type = 'contact' AND e.entity_id = ct.id)
        ) AS evidence_count,
        (SELECT group_concat(source_url, '; ')
          FROM (
            SELECT DISTINCT e.source_url AS source_url
            FROM evidence e
            WHERE e.source_url IS NOT NULL
              AND ((e.entity_type = 'company' AND e.entity_id = c.id)
                OR (e.entity_type = 'contact' AND e.entity_id = ct.id))
            ORDER BY e.source_url
          )
        ) AS evidence_urls,
        (SELECT d.status FROM outreach_drafts d
          WHERE d.company_id = c.id
            AND (ct.id IS NULL OR d.contact_id = ct.id)
          ORDER BY d.updated_at DESC LIMIT 1
        ) AS last_outreach_status,
        (SELECT COALESCE(d.sent_at, d.updated_at) FROM outreach_drafts d
          WHERE d.company_id = c.id
            AND (ct.id IS NULL OR d.contact_id = ct.id)
          ORDER BY d.updated_at DESC LIMIT 1
        ) AS last_outreach_at
       FROM companies c
       LEFT JOIN contacts ct ON ct.company_id = c.id
       ORDER BY c.hiring_score DESC, c.name ASC, ct.rank ASC`,
    )
    .all(jobWindow, jobWindow, jobWindow) as Record<string, unknown>[];
}
