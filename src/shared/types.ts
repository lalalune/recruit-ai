import { z } from "zod";

export const companyStatuses = [
  "new",
  "needs_research",
  "ready_for_review",
  "approved",
  "rejected",
  "archived",
] as const;

export const contactStatuses = [
  "candidate",
  "primary",
  "alternate",
  "invalid",
  "left_company",
  "suppressed",
] as const;

export const emailStatuses = [
  "unverified",
  "valid",
  "accept_all",
  "unknown",
  "invalid",
  "disposable",
  "do_not_mail",
] as const;

export const priorityLevels = ["high", "medium", "low"] as const;

export const CompanyPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  domain: z.string().trim().optional().nullable(),
  websiteUrl: z.string().trim().optional().nullable(),
  linkedinUrl: z.string().trim().optional().nullable(),
  ycUrl: z.string().trim().optional().nullable(),
  description: z.string().trim().optional().nullable(),
  location: z.string().trim().optional().nullable(),
  employeeCountMin: z.number().int().nonnegative().optional().nullable(),
  employeeCountMax: z.number().int().nonnegative().optional().nullable(),
  industries: z.array(z.string()).optional(),
  stage: z.string().trim().optional().nullable(),
  status: z.enum(companyStatuses).optional(),
  priority: z.enum(priorityLevels).optional(),
  fitConfirmed: z.boolean().optional(),
  recruitingFit: z
    .enum(["unknown", "likely", "unlikely", "excluded"])
    .optional(),
  recruitingFitNote: z.string().max(2_000).optional().nullable(),
  exclusionReason: z
    .enum([
      "outside_bay_area",
      "outside_size_range",
      "not_technology_startup",
      "not_hiring",
      "large_internal_recruiting",
      "agencies_not_accepted",
      "mission_outside_scope",
      "duplicate",
      "other",
    ])
    .optional()
    .nullable(),
  exclusionNote: z.string().max(2_000).optional().nullable(),
  notes: z.string().optional().nullable(),
  reviewed: z.boolean().optional(),
});

export const ContactPatchSchema = z.object({
  firstName: z.string().trim().optional().nullable(),
  lastName: z.string().trim().optional().nullable(),
  fullName: z.string().trim().min(1).optional(),
  title: z.string().trim().optional().nullable(),
  roleCategory: z.string().trim().optional().nullable(),
  email: z.string().trim().optional().nullable(),
  emailType: z.enum(["work", "personal", "generic", "unknown"]).optional(),
  fallbackReason: z.string().trim().max(1_000).optional().nullable(),
  fallbackConfirmed: z.boolean().optional(),
  emailStatus: z.enum(emailStatuses).optional(),
  emailVerifiedAt: z.string().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  phoneType: z.enum(["business", "direct", "mobile", "switchboard", "unknown"]).optional(),
  phoneConfirmed: z.boolean().optional(),
  phoneSource: z.string().trim().max(1_000).optional().nullable(),
  linkedinUrl: z.string().trim().optional().nullable(),
  employmentConfirmed: z.boolean().optional(),
  observedTitle: z.string().trim().max(500).optional().nullable(),
  employmentObservedAt: z.string().optional().nullable(),
  rank: z.number().int().min(1).max(99).optional(),
  status: z.enum(contactStatuses).optional(),
  reviewed: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

export const DiscoveryRunSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("datasf"),
    limit: z.number().int().min(1).max(10_000).default(500),
    technologyOnly: z.boolean().default(true),
  }),
  z.object({
    source: z.literal("hackernews"),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  z.object({
    source: z.literal("apollo"),
    limit: z.number().int().min(1).max(10_000).default(500),
  }),
  z.object({
    source: z.literal("brave_domains"),
    limit: z.number().int().min(1).max(10_000).default(250),
    autoApplyHighConfidence: z.boolean().default(false),
  }),
  z.object({
    source: z.literal("company_websites"),
    limit: z.number().int().min(1).max(10_000).default(250),
  }),
  z.object({
    source: z.literal("job_board"),
    provider: z.enum(["greenhouse", "lever", "ashby"]),
    identifier: z.string().trim().min(1),
    companyId: z.string().uuid().optional(),
  }),
]);

export const CsvImportSchema = z.object({
  csv: z.string().min(1).max(20 * 1024 * 1024),
  sourceLabel: z.string().trim().min(1).max(300).default("CSV import"),
  mapping: z
    .record(
      z.string(),
      z.enum([
        "ignore",
        "company_name",
        "domain",
        "website_url",
        "location",
        "company_size",
        "employee_count_min",
        "employee_count_max",
        "industries",
        "stage",
        "description",
        "company_linkedin_url",
        "yc_url",
        "full_name",
        "first_name",
        "last_name",
        "title",
        "role_category",
        "email",
        "email_type",
        "phone",
        "phone_type",
        "phone_confirmed",
        "phone_source",
        "person_linkedin_url",
        "rank",
        "notes",
        "source_url",
      ]),
    )
    .optional(),
});

export const DraftRequestSchema = z.object({
  contactId: z.string().uuid(),
  tone: z.enum(["concise", "technical", "founder"]).default("concise"),
});

export const SettingsPatchSchema = z
  .object({
    scopeLocation: z.string().trim().min(1).max(200).optional(),
    employeeMin: z.coerce.number().int().min(3).max(1_000).optional(),
    employeeMax: z.coerce.number().int().min(3).max(1_000).optional(),
    industries: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    jobFreshnessDays: z.coerce.number().int().min(30).max(180).optional(),
    jobRefreshDays: z.coerce.number().int().min(7).max(365).optional(),
    maxEvidenceAgeDays: z.coerce.number().int().min(30).max(365).optional(),
    companySitePageLimit: z.coerce.number().int().min(1).max(20).optional(),
    technologyOnlyDataSf: z.boolean().optional(),
    autoPrioritizeHiring: z.boolean().optional(),
    emailFreshnessDays: z.coerce.number().int().min(1).max(30).optional(),
    catchAllPolicy: z
      .enum(["review", "exclude", "allow_last_resort"])
      .optional(),
    excludeSocialJustice: z.boolean().optional(),
    primaryVerifier: z.literal("hunter").optional(),
    secondVerifier: z.enum(["none", "zerobounce"]).optional(),
    gmail_hourly_cap: z.coerce.number().int().min(1).max(20).optional(),
    gmail_daily_cap: z.coerce.number().int().min(1).max(400).optional(),
    sending_window_start: z.coerce.number().int().min(0).max(23).optional(),
    sending_window_end: z.coerce.number().int().min(1).max(24).optional(),
    gmail_sending_enabled: z.boolean().optional(),
    sending_days: z
      .array(z.coerce.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .transform((days) => Array.from(new Set(days)))
      .optional(),
    time_zone: z.string().trim().min(1).max(100).optional(),
    sender_name: z.string().max(200).optional(),
    organization_name: z.string().max(300).optional(),
    postal_address: z.string().max(1_000).optional(),
    opt_out_text: z.string().max(500).optional(),
    reply_handling_note: z.string().max(1_000).optional(),
    compliance_confirmed: z.boolean().optional(),
    no_response_wait_days: z.coerce.number().int().min(1).max(90).optional(),
    bounce_pause_enabled: z.boolean().optional(),
    bounce_threshold: z.coerce.number().int().min(1).max(20).optional(),
  })
  .strict();

export type CompanyStatus = (typeof companyStatuses)[number];
export type ContactStatus = (typeof contactStatuses)[number];
export type EmailStatus = (typeof emailStatuses)[number];
export type Priority = (typeof priorityLevels)[number];
export type DiscoveryRunRequest = z.infer<typeof DiscoveryRunSchema>;

export interface CompanyListItem {
  id: string;
  name: string;
  domain: string | null;
  websiteUrl: string | null;
  location: string | null;
  employeeCountMin: number | null;
  employeeCountMax: number | null;
  industries: string[];
  stage: string | null;
  status: CompanyStatus;
  priority: Priority;
  fitConfirmed: boolean;
  recruitingFit: "unknown" | "likely" | "unlikely" | "excluded";
  recruitingFitNote: string | null;
  exclusionReason: string | null;
  reviewed: boolean;
  hiringScore: number;
  hiringScoreBreakdown: HiringScoreBreakdown;
  openRolesCount: number;
  freshRolesCount: number;
  conflictCount: number;
  primaryContact: ContactSummary | null;
  sourceLabels: string[];
  updatedAt: string;
}

export interface ContactSummary {
  id: string;
  fullName: string;
  title: string | null;
  roleCategory: string | null;
  email: string | null;
  emailType: "work" | "personal" | "generic" | "unknown";
  fallbackReason: string | null;
  fallbackConfirmed: boolean;
  emailStatus: EmailStatus;
  emailVerifiedAt: string | null;
  phone: string | null;
  phoneType: "business" | "direct" | "mobile" | "switchboard" | "unknown";
  phoneConfirmed: boolean;
  phoneSource: string | null;
  linkedinUrl: string | null;
  employmentConfirmed: boolean;
  observedTitle: string | null;
  employmentObservedAt: string | null;
  rank: number;
  status: ContactStatus;
  reviewed: boolean;
  notes: string | null;
}

export interface EvidenceItem {
  id: string;
  entityType: "company" | "contact" | "job";
  entityId: string;
  fieldName: string;
  value: string | null;
  sourceType: string;
  sourceLabel: string;
  sourceUrl: string | null;
  excerpt: string | null;
  screenshotPath: string | null;
  confidence: number;
  capturedAt: string;
}

export interface JobItem {
  id: string;
  title: string;
  location: string | null;
  department: string | null;
  url: string | null;
  sourceType: string;
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  active: boolean;
  confirmedLive: boolean;
  observedAt: string | null;
}

export interface CompanyDetail extends CompanyListItem {
  linkedinUrl: string | null;
  ycUrl: string | null;
  description: string | null;
  exclusionNote: string | null;
  notes: string | null;
  lastResearchedAt: string | null;
  contacts: ContactSummary[];
  jobs: JobItem[];
  evidence: EvidenceItem[];
  conflicts: ConflictItem[];
  audit: AuditItem[];
  readiness: ReadinessItem[];
}

export interface HiringScoreBreakdown {
  liveHiring: number;
  freshness: number;
  companyFit: number;
  externalHelpFit: number;
  evidenceQuality: number;
}

export interface ConflictItem {
  id: string;
  companyId: string;
  entityType: "company" | "contact" | "job";
  entityId: string;
  fieldName: string;
  currentValue: string | null;
  candidateValue: string | null;
  evidenceId: string | null;
  status: "open" | "resolved" | "researching";
  resolution: "use_candidate" | "keep_current" | "research_further" | null;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ReadinessItem {
  id:
    | "company_fit"
    | "hiring_now"
    | "decision_maker"
    | "contact_route"
    | "email_current"
    | "evidence_freshness"
    | "conflicts"
    | "suppression";
  label: string;
  state: "complete" | "needs_attention" | "blocked";
  detail: string;
}

export interface AuditItem {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  summary: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface DashboardSummary {
  companies: number;
  needsReview: number;
  approved: number;
  reviewed: number;
  contacts: number;
  validEmails: number;
  openRoles: number;
  conflicts: number;
}

export interface SourceRunItem {
  id: string;
  sourceType: string;
  status: "queued" | "running" | "completed" | "failed";
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface OutreachDraft {
  id: string;
  companyId: string;
  companyName: string;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  subject: string;
  body: string;
  editedAt: string | null;
  status:
    | "draft"
    | "approved"
    | "sending"
    | "send_unknown"
    | "gmail_draft"
    | "scheduled"
    | "sent"
    | "no_response"
    | "replied"
    | "bounced";
  scheduledAt: string | null;
  sentAt: string | null;
  outcomeAt: string | null;
  outcomeNote: string | null;
  updatedAt: string;
}

export interface ApiResult<T> {
  data: T;
  meta?: Record<string, unknown>;
}
