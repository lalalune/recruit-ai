import { Hono, type Context } from "hono";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { APP_VERSION } from "../shared/version";
import {
  CompanyPatchSchema,
  ContactPatchSchema,
  CsvImportSchema,
  DiscoveryRunSchema,
  DraftRequestSchema,
  HttpUrlSchema,
  SettingsPatchSchema,
} from "../shared/types";
import { createContactsCsv } from "./csv";
import { AppError, badRequest } from "./errors";
import { testProviderConnection } from "./connections";
import {
  clearDemoData,
  compactDatabase,
  createFullBackup,
  deleteWorkingData,
  getBackupFile,
  getLocalDataStatus,
  inspectBackup,
  openDataDirectory,
  restoreFullBackup,
} from "./dataManagement";
import { generateDraft } from "./drafting";
import {
  completeGmailAuthorization,
  createGmailAuthorizationUrl,
  disconnectGmail,
  getGmailStatus,
  gmailSettingsRedirect,
  sendGmailTestMessage,
  sendApprovedDraft,
} from "./gmail";
import { importCsv, loadDemoWorkspace, startDiscovery } from "./discovery";
import {
  addContact,
  addEvidence,
  addManualJob,
  addSuppression,
  countDrafts,
  getCompany,
  getDashboardSummary,
  getEvidence,
  getSettings,
  excludeCompany,
  listCompanies,
  listDrafts,
  listSuppressions,
  listSourceRuns,
  getDraft,
  patchCompany,
  patchContact,
  patchDraft,
  recomputeAllCompanyStats,
  recordDraftOutcome,
  recordReview,
  resolveConflict,
  resolveUnknownDraft,
  saveSetting,
} from "./repository";
import { getConnectionSummary, getSecret, saveSecrets } from "./secrets";
import { getDataDir, getSnapshotsDir } from "./paths";
import { withMutableOperation } from "./operationState";
import { enrichCompanyWithApollo } from "./sources/apollo";
import {
  findEmailWithHunter,
  verifyEmailWithHunter,
  verifyEmailWithZeroBounce,
} from "./sources/email";
import { researchCompanyWebsite } from "./sources/website";
import { resolveCompanyDomainWithBrave } from "./sources/webSearch";

const ReviewSchema = z
  .object({
    decision: z.enum(["approved", "rejected", "needs_research"]),
    notes: z.string().trim().max(2_000).optional(),
  })
  .refine(
    (value) =>
      value.decision === "approved" || Boolean(value.notes?.trim()),
    {
      message: "Record a reason for a rejection or further research.",
      path: ["notes"],
    },
  )
  .strict();

const ManualEvidenceSchema = z
  .object({
    entityType: z.enum(["company", "contact", "job"]),
    entityId: z.string().uuid(),
    fieldName: z.string().trim().min(1).max(200),
    value: z.string().trim().max(5_000).optional().nullable(),
    sourceUrl: HttpUrlSchema.optional().nullable(),
    excerpt: z.string().trim().max(5_000).optional().nullable(),
    confirmed: z.literal(true),
  })
  .refine((value) => Boolean(value.value || value.excerpt), {
    message: "Add a value or source note for the confirmed evidence.",
    path: ["value"],
  })
  .strict();

const ManualJobSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    location: z.string().trim().max(500).optional().nullable(),
    department: z.string().trim().max(500).optional().nullable(),
    url: HttpUrlSchema.optional().nullable(),
    postedAt: z.string().max(100).optional().nullable(),
    observedAt: z.string().min(1).max(100),
    excerpt: z.string().max(5_000).optional().nullable(),
    confirmedLive: z.literal(true),
    noPublicUrl: z.boolean().default(false),
  })
  .refine((value) => value.url || value.noPublicUrl, {
    message: "Add a public URL or confirm that no public URL is available.",
    path: ["url"],
  })
  .strict();

const ExclusionSchema = z
  .object({
    reason: z.enum([
      "outside_bay_area",
      "outside_size_range",
      "not_technology_startup",
      "not_hiring",
      "large_internal_recruiting",
      "agencies_not_accepted",
      "mission_outside_scope",
      "duplicate",
      "other",
    ]),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict()
  .refine((value) => value.reason !== "other" || Boolean(value.note), {
    message: "A note is required for Other.",
    path: ["note"],
  });

const ConflictResolutionSchema = z
  .object({
    resolution: z.enum(["use_candidate", "keep_current", "research_further"]),
    note: z.string().trim().min(1).max(2_000),
  })
  .strict();

const SecretValueSchema = z.string().trim().max(10_000).nullable();
const SecretSchema = z
  .object({
    APOLLO_API_KEY: SecretValueSchema.optional(),
    HUNTER_API_KEY: SecretValueSchema.optional(),
    ZEROBOUNCE_API_KEY: SecretValueSchema.optional(),
    SOCRATA_APP_TOKEN: SecretValueSchema.optional(),
    BRAVE_SEARCH_API_KEY: SecretValueSchema.optional(),
    GOOGLE_CLIENT_ID: SecretValueSchema.optional(),
    GOOGLE_CLIENT_SECRET: SecretValueSchema.optional(),
  })
  .strict();
const ProviderTestSchema = z
  .object({
    provider: z.enum(["apollo", "hunter", "zerobounce", "socrata", "brave"]),
  })
  .strict();
const BackupBodySchema = z
  .object({
    backupText: z.string().min(1).max(500 * 1024 * 1024),
  })
  .strict();
const RestoreBodySchema = BackupBodySchema.extend({
  confirmation: z.literal("RESTORE LOCAL DATA"),
});
const ConfirmationSchema = z
  .object({
    confirmation: z.string().max(100),
  })
  .strict();
const ContactEditorSchema = ContactPatchSchema.omit({
  emailStatus: true,
  emailVerifiedAt: true,
});
const SuppressionSchema = z
  .object({
    value: z.string().trim().min(1).max(2_000),
    kind: z.enum(["email", "domain", "person", "company"]),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();
const DraftPatchSchema = z
  .object({
    subject: z.string().trim().min(1).max(998).optional(),
    body: z.string().trim().min(1).max(100_000).optional(),
    status: z.enum(["draft", "approved"]).optional(),
    scheduledAt: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Include at least one draft field to update.",
  });
const DraftOutcomeSchema = z
  .object({
    outcome: z.enum(["replied", "bounced", "no_response"]),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();
const UnknownSendResolutionSchema = z
  .object({
    resolution: z.enum(["sent", "not_sent"]),
    note: z.string().trim().min(1).max(2_000),
  })
  .strict();
const DomainResearchSchema = z
  .object({
    autoApplyHighConfidence: z.boolean().optional(),
  })
  .strict();
const DraftListQuerySchema = z
  .object({
    view: z.enum(["active", "approved", "all"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();

const CompanyListQuerySchema = z
  .object({
    search: z.string().trim().max(500).optional(),
    status: z
      .enum([
        "all",
        "new",
        "needs_research",
        "ready_for_review",
        "approved",
        "rejected",
        "archived",
      ])
      .optional(),
    reviewed: z.enum(["true", "false"]).optional(),
    priority: z.enum(["all", "high", "medium", "low"]).optional(),
    hasOpenRoles: z.enum(["true", "false"]).optional(),
    needs: z
      .enum([
        "all",
        "fresh_jobs",
        "missing_decision_maker",
        "missing_email",
        "email_verification",
        "conflicts",
        "ready_final",
      ])
      .optional(),
    sort: z.enum(["hiring", "recent", "roles", "name", "oldest"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();

async function readJson(c: Context) {
  try {
    return await c.req.json();
  } catch {
    throw badRequest("Request body must be valid JSON.", "invalid_json");
  }
}

export function isAllowedLoopbackHost(value: string | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(`http://${value}`);
    const hostname = parsed.hostname
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .replace(/\.$/, "")
      .toLowerCase();
    return (
      !parsed.username &&
      !parsed.password &&
      ["127.0.0.1", "localhost", "::1"].includes(hostname)
    );
  } catch {
    return false;
  }
}

function isAllowedLoopbackOrigin(value: string | undefined) {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      !parsed.username &&
      !parsed.password &&
      isAllowedLoopbackHost(parsed.host)
    );
  } catch {
    return false;
  }
}

export function createApp() {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    const requestHost =
      c.req.header("host") || new URL(c.req.url).host;
    if (
      !isAllowedLoopbackHost(requestHost) ||
      !isAllowedLoopbackOrigin(c.req.header("origin"))
    ) {
      return c.json({ error: "Requests must originate from the local application." }, 403);
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.header("X-RecruitAI-Client") !== "1"
    ) {
      return c.json({ error: "Missing local client header." }, 403);
    }
    await next();
  });

  app.get("/api/health", (c) =>
    c.json({
      data: {
        ok: true,
        version: APP_VERSION,
        runtime: `Bun ${Bun.version}`,
      },
    }),
  );

  app.get("/api/dashboard", (c) => c.json({ data: getDashboardSummary() }));

  app.get("/api/companies", (c) => {
    const parsed = CompanyListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: "Invalid company query.", details: parsed.error.flatten() },
        400,
      );
    }
    const query = parsed.data;
    const result = listCompanies({
      search: query.search,
      status: query.status,
      reviewed: query.reviewed,
      priority: query.priority,
      hasOpenRoles: query.hasOpenRoles,
      needs: query.needs,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json({ data: result.items, meta: { ...result, items: undefined } });
  });

  app.get("/api/companies/:id", (c) => {
    const company = getCompany(c.req.param("id"));
    return company
      ? c.json({ data: company })
      : c.json({ error: "Company not found." }, 404);
  });

  app.patch("/api/companies/:id", async (c) => {
    const parsed = CompanyPatchSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "Invalid company update.", details: parsed.error.flatten() }, 400);
    }
    const current = getCompany(c.req.param("id"));
    if (!current) return c.json({ error: "Company not found." }, 404);
    const employeeMin =
      parsed.data.employeeCountMin === undefined
        ? current.employeeCountMin
        : parsed.data.employeeCountMin;
    const employeeMax =
      parsed.data.employeeCountMax === undefined
        ? current.employeeCountMax
        : parsed.data.employeeCountMax;
    if (
      employeeMin !== null &&
      employeeMax !== null &&
      employeeMin > employeeMax
    ) {
      return c.json(
        { error: "Minimum employees cannot exceed maximum employees." },
        400,
      );
    }
    const company = patchCompany(c.req.param("id"), parsed.data);
    return company
      ? c.json({ data: company })
      : c.json({ error: "Company not found." }, 404);
  });

  app.post("/api/companies/:id/contacts", async (c) => {
    const body = await readJson(c);
    const parsed = ContactEditorSchema.extend({
      fullName: z.string().trim().min(1).max(500),
    }).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid contact.", details: parsed.error.flatten() }, 400);
    }
    const company = getCompany(c.req.param("id"));
    if (!company) return c.json({ error: "Company not found." }, 404);
    return c.json({ data: addContact(company.id, parsed.data) }, 201);
  });

  app.patch("/api/contacts/:id", async (c) => {
    const parsed = ContactEditorSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "Invalid contact update.", details: parsed.error.flatten() }, 400);
    }
    const contact = patchContact(c.req.param("id"), parsed.data);
    return contact
      ? c.json({ data: contact })
      : c.json({ error: "Contact not found." }, 404);
  });

  app.post("/api/companies/:id/review", async (c) => {
    const parsed = ReviewSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "Invalid review decision.", details: parsed.error.flatten() }, 400);
    }
    const company = getCompany(c.req.param("id"));
    if (!company) return c.json({ error: "Company not found." }, 404);
    return c.json({
      data: recordReview(company.id, parsed.data.decision, parsed.data.notes),
    });
  });

  app.post("/api/companies/:id/exclude", async (c) => {
    const parsed = ExclusionSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid exclusion.", details: parsed.error.flatten() },
        400,
      );
    }
    const company = getCompany(c.req.param("id"));
    if (!company) return c.json({ error: "Company not found." }, 404);
    return c.json({
      data: excludeCompany(company.id, parsed.data.reason, parsed.data.note),
    });
  });

  app.post("/api/companies/:id/jobs/manual", async (c) => {
    const parsed = ManualJobSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid manual job.", details: parsed.error.flatten() },
        400,
      );
    }
    const company = getCompany(c.req.param("id"));
    if (!company) return c.json({ error: "Company not found." }, 404);
    return c.json(
      { data: addManualJob(company.id, parsed.data) },
      201,
    );
  });

  app.post("/api/conflicts/:id/resolve", async (c) => {
    const parsed = ConflictResolutionSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid conflict resolution.", details: parsed.error.flatten() },
        400,
      );
    }
    return c.json({
      data: resolveConflict(
        c.req.param("id"),
        parsed.data.resolution,
        parsed.data.note,
      ),
    });
  });

  app.post("/api/evidence/manual", async (c) => {
    const parsed = ManualEvidenceSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "Invalid evidence.", details: parsed.error.flatten() }, 400);
    }
    const id = addEvidence({
      ...parsed.data,
      sourceType: "manual",
      sourceLabel: parsed.data.confirmed
        ? "Manually confirmed"
        : "Manual observation",
      confidence: parsed.data.confirmed ? 0.9 : 0.6,
    });
    return c.json({ data: { id } }, 201);
  });

  app.get("/api/evidence/:id/snapshot", (c) => {
    const evidence = getEvidence(c.req.param("id"));
    if (!evidence?.screenshotPath) {
      return c.json({ error: "Saved snapshot not found." }, 404);
    }

    let snapshotsRoot: string;
    let snapshotPath: string;
    try {
      snapshotsRoot = realpathSync(getSnapshotsDir());
      snapshotPath = realpathSync(evidence.screenshotPath);
    } catch {
      return c.json({ error: "Saved snapshot not found." }, 404);
    }

    const relativePath = path.relative(snapshotsRoot, snapshotPath);
    const insideSnapshots =
      relativePath !== "" &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath);
    if (!insideSnapshots) {
      return c.json({ error: "Saved snapshot path is outside the snapshots directory." }, 403);
    }

    let snapshotStat;
    try {
      snapshotStat = statSync(snapshotPath);
    } catch {
      return c.json({ error: "Saved snapshot not found." }, 404);
    }
    if (!snapshotStat.isFile()) {
      return c.json({ error: "Saved snapshot not found." }, 404);
    }

    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header(
      "Content-Disposition",
      'inline; filename="evidence-snapshot.txt"',
    );
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    return c.body(readFileSync(snapshotPath, "utf8"));
  });

  app.get("/api/source-runs", (c) => c.json({ data: listSourceRuns() }));

  app.post("/api/discovery/run", async (c) => {
    const parsed = DiscoveryRunSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "Invalid discovery run.", details: parsed.error.flatten() }, 400);
    }
    const runId = startDiscovery(parsed.data);
    return c.json({ data: { runId } }, 202);
  });

  app.post("/api/discovery/import", async (c) => {
    const parsed = CsvImportSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "Invalid CSV import.", details: parsed.error.flatten() }, 400);
    }
    return c.json({
      data: importCsv(
        parsed.data.csv,
        parsed.data.sourceLabel,
        parsed.data.mapping,
      ),
    });
  });

  app.post("/api/discovery/demo", (c) =>
    c.json({ data: loadDemoWorkspace() }, 201),
  );

  app.post("/api/companies/:id/research/website", async (c) => {
    const result = await withMutableOperation("website research", () =>
      researchCompanyWebsite(c.req.param("id")),
    );
    return c.json({ data: result });
  });

  app.post("/api/companies/:id/research/apollo", async (c) => {
    const result = await withMutableOperation("Apollo research", () =>
      enrichCompanyWithApollo(c.req.param("id")),
    );
    return c.json({ data: result });
  });

  app.post("/api/companies/:id/research/domain", async (c) => {
    const body = DomainResearchSchema.safeParse(await readJson(c));
    if (!body.success) {
      return c.json(
        { error: "Invalid domain research request.", details: body.error.flatten() },
        400,
      );
    }
    const result = await withMutableOperation("domain research", () =>
      resolveCompanyDomainWithBrave(
        c.req.param("id"),
        body.data.autoApplyHighConfidence === true,
      ),
    );
    return c.json({ data: result });
  });

  app.post("/api/companies/:companyId/contacts/:contactId/find-email", async (c) => {
    const result = await withMutableOperation("email discovery", () =>
      findEmailWithHunter(
        c.req.param("companyId"),
        c.req.param("contactId"),
      ),
    );
    return c.json({ data: result });
  });

  app.post("/api/contacts/:id/verify", async (c) => {
    const provider = c.req.query("provider") || "hunter";
    if (!["hunter", "zerobounce"].includes(provider)) {
      return c.json({ error: "Unsupported verification provider." }, 400);
    }
    const result = await withMutableOperation("email verification", () =>
      provider === "zerobounce"
        ? verifyEmailWithZeroBounce(c.req.param("id"))
        : verifyEmailWithHunter(c.req.param("id")),
    );
    return c.json({ data: result });
  });

  app.get("/api/verification/providers", (c) =>
    c.json({
      data: [
        {
          id: "hunter",
          name: "Hunter",
          role: "Finder and primary verifier",
          pricing:
            "Finder and verifier metering depends on the current Hunter product and plan; links and planning ranges are in the Research Plan.",
        },
        {
          id: "zerobounce",
          name: "ZeroBounce",
          role: "Optional second-opinion verifier",
          pricing:
            "Optional pay-as-you-go verification; current rates and treatment of unknown results are linked in the Research Plan.",
        },
      ],
    }),
  );

  app.get("/api/outreach/drafts", (c) => {
    const parsed = DraftListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: "Invalid draft query.", details: parsed.error.flatten() },
        400,
      );
    }
    const view = parsed.data.view || "all";
    const limit = parsed.data.limit || 100;
    const offset = parsed.data.offset || 0;
    return c.json({
      data: listDrafts({ view, limit, offset }),
      meta: { total: countDrafts(view), limit, offset },
    });
  });

  app.get("/api/outreach/drafts/:id", (c) => {
    const draft = getDraft(c.req.param("id"));
    return draft
      ? c.json({ data: draft })
      : c.json({ error: "Draft not found." }, 404);
  });

  app.get("/api/suppressions", (c) => c.json({ data: listSuppressions() }));

  app.post("/api/suppressions", async (c) => {
    const parsed = SuppressionSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid suppression.", details: parsed.error.flatten() },
        400,
      );
    }
    return c.json(
      {
        data: addSuppression(
          parsed.data.value,
          parsed.data.kind,
          parsed.data.reason,
        ),
      },
      201,
    );
  });

  app.post("/api/outreach/generate", async (c) => {
    const parsed = DraftRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "Invalid draft request.", details: parsed.error.flatten() }, 400);
    }
    const companyId = z.string().uuid().safeParse(c.req.query("companyId"));
    if (!companyId.success) {
      return c.json({ error: "A valid companyId is required." }, 400);
    }
    return c.json({
      data: generateDraft(
        companyId.data,
        parsed.data.contactId,
        parsed.data.tone,
      ),
    });
  });

  app.patch("/api/outreach/drafts/:id", async (c) => {
    const parsed = DraftPatchSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "Invalid draft update.", details: parsed.error.flatten() }, 400);
    }
    const draft = patchDraft(c.req.param("id"), parsed.data);
    return draft
      ? c.json({ data: draft })
      : c.json({ error: "Draft not found." }, 404);
  });

  app.get("/api/gmail/status", (c) => c.json({ data: getGmailStatus() }));

  app.post("/api/gmail/auth-url", (c) =>
    c.json({ data: { url: createGmailAuthorizationUrl() } }),
  );

  app.get("/api/gmail/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const oauthError = c.req.query("error");
    if (oauthError || !code || !state) {
      return c.redirect(gmailSettingsRedirect("error"));
    }
    try {
      await withMutableOperation("Gmail authorization", () =>
        completeGmailAuthorization(code, state),
      );
      return c.redirect(gmailSettingsRedirect("connected"));
    } catch (error) {
      console.error(error);
      return c.redirect(gmailSettingsRedirect("error"));
    }
  });

  app.post("/api/gmail/disconnect", (c) =>
    c.json({ data: disconnectGmail() }),
  );

  app.post("/api/gmail/test", async (c) =>
    c.json({
      data: await withMutableOperation("Gmail test", sendGmailTestMessage),
    }),
  );

  app.post("/api/outreach/drafts/:id/send", async (c) =>
    c.json({ data: await sendApprovedDraft(c.req.param("id")) }),
  );

  app.post("/api/outreach/drafts/:id/resolve-send", async (c) => {
    const parsed = UnknownSendResolutionSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid delivery resolution.",
          details: parsed.error.flatten(),
        },
        400,
      );
    }
    return c.json({
      data: resolveUnknownDraft(
        c.req.param("id"),
        parsed.data.resolution,
        parsed.data.note,
      ),
    });
  });

  app.post("/api/outreach/drafts/:id/outcome", async (c) => {
    const parsed = DraftOutcomeSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid outreach outcome.", details: parsed.error.flatten() },
        400,
      );
    }
    return c.json({
      data: recordDraftOutcome(
        c.req.param("id"),
        parsed.data.outcome,
        parsed.data.note,
      ),
    });
  });

  app.get("/api/export/contacts.csv", (c) => {
    const csv = createContactsCsv();
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header(
      "Content-Disposition",
      `attachment; filename="recruitai-contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return c.body(csv);
  });

  app.get("/api/data/status", (c) =>
    c.json({ data: getLocalDataStatus() }),
  );

  app.post("/api/data/backup", (c) =>
    c.json({ data: createFullBackup() }, 201),
  );

  app.get("/api/data/backups/:fileName", (c) => {
    const backup = getBackupFile(c.req.param("fileName"));
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header(
      "Content-Disposition",
      `attachment; filename="${backup.fileName}"`,
    );
    return c.body(readFileSync(backup.filePath));
  });

  app.post("/api/data/backup/inspect", async (c) => {
    const parsed = BackupBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "Invalid backup data." }, 400);
    return c.json({ data: inspectBackup(parsed.data.backupText) });
  });

  app.post("/api/data/restore", async (c) => {
    const parsed = RestoreBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "Type RESTORE LOCAL DATA to confirm the restore." },
        400,
      );
    }
    return c.json({ data: restoreFullBackup(parsed.data.backupText) });
  });

  app.post("/api/data/compact", (c) =>
    c.json({ data: compactDatabase() }),
  );

  app.post("/api/data/clear-demo", async (c) => {
    const parsed = ConfirmationSchema.safeParse(await readJson(c));
    if (!parsed.success || parsed.data.confirmation !== "CLEAR DEMO DATA") {
      return c.json(
        { error: "Type CLEAR DEMO DATA to remove fictional records." },
        400,
      );
    }
    return c.json({ data: clearDemoData() });
  });

  app.post("/api/data/delete-all", async (c) => {
    const parsed = ConfirmationSchema.safeParse(await readJson(c));
    if (!parsed.success || parsed.data.confirmation !== "DELETE LOCAL DATA") {
      return c.json(
        { error: "Type DELETE LOCAL DATA to confirm deletion." },
        400,
      );
    }
    return c.json({ data: deleteWorkingData() });
  });

  app.post("/api/data/open-folder", (c) =>
    c.json({ data: openDataDirectory() }),
  );

  app.get("/api/settings", (c) =>
    c.json({
      data: {
        values: getSettings(),
        connections: getConnectionSummary(),
        dataDirectory: getDataDir(),
      },
    }),
  );

  app.patch("/api/settings", async (c) => {
    const parsed = SettingsPatchSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "Invalid settings.", details: parsed.error.flatten() }, 400);
    }
    const current = getSettings();
    const employeeMin = Number(
      parsed.data.employeeMin ?? current.employeeMin ?? 3,
    );
    const employeeMax = Number(
      parsed.data.employeeMax ?? current.employeeMax ?? 1_000,
    );
    if (employeeMin > employeeMax) {
      return c.json(
        { error: "Minimum employees cannot exceed maximum employees." },
        400,
      );
    }
    const windowStart = Number(
      parsed.data.sending_window_start ?? current.sending_window_start ?? 8,
    );
    const windowEnd = Number(
      parsed.data.sending_window_end ?? current.sending_window_end ?? 20,
    );
    if (windowStart >= windowEnd) {
      return c.json(
        { error: "The sending window must end after it starts." },
        400,
      );
    }
    if (parsed.data.time_zone) {
      try {
        new Intl.DateTimeFormat("en-US", {
          timeZone: parsed.data.time_zone,
        }).format(new Date());
      } catch {
        return c.json({ error: "Enter a valid IANA time zone." }, 400);
      }
    }
    if (parsed.data.gmail_sending_enabled === true) {
      const combined: Record<string, unknown> = { ...current, ...parsed.data };
      const missing = [
        !getSecret("GOOGLE_REFRESH_TOKEN") ? "connected Gmail account" : null,
        !String(combined.sender_name || "").trim() ? "sender name" : null,
        !String(combined.postal_address || "").trim() ? "postal address" : null,
        !String(combined.opt_out_text || "").trim() ? "opt-out instruction" : null,
        combined.compliance_confirmed !== true
          ? "compliance confirmation"
          : null,
        !combined["gmail_test_passed_at"] ? "successful test message" : null,
      ].filter(Boolean);
      if (missing.length) {
        return c.json(
          { error: `Sending cannot be enabled: ${missing.join(", ")}.` },
          400,
        );
      }
    }
    const selfTestInputs = [
      "sender_name",
      "organization_name",
      "postal_address",
      "opt_out_text",
      "compliance_confirmed",
    ] as const;
    const invalidatesSelfTest = selfTestInputs.some(
      (key) =>
        parsed.data[key] !== undefined &&
        parsed.data[key] !== current[key],
    );
    for (const [key, value] of Object.entries(parsed.data)) saveSetting(key, value);
    if (invalidatesSelfTest) {
      saveSetting("gmail_test_passed_at", null);
      saveSetting("gmail_sending_enabled", false);
    }
    if (
      parsed.data.jobFreshnessDays !== undefined ||
      parsed.data.autoPrioritizeHiring !== undefined
    ) {
      recomputeAllCompanyStats();
    }
    return c.json({ data: getSettings() });
  });

  app.patch("/api/settings/secrets", async (c) => {
    const parsed = SecretSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "Invalid secrets.", details: parsed.error.flatten() }, 400);
    }
    const googleCredentialsChanged = (
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const
    ).some((key) => {
      if (parsed.data[key] === undefined) return false;
      return (parsed.data[key]?.trim() || null) !== getSecret(key);
    });
    const data = saveSecrets(parsed.data);
    if (googleCredentialsChanged) disconnectGmail();
    return c.json({ data: googleCredentialsChanged ? getConnectionSummary() : data });
  });

  app.post("/api/settings/connections/test", async (c) => {
    const parsed = ProviderTestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "Invalid provider test." }, 400);
    }
    return c.json({
      data: await testProviderConnection(parsed.data.provider),
    });
  });

  app.get("/api/source-policies", (c) =>
    c.json({
      data: [
        {
          id: "company_websites",
          name: "Company websites",
          mode: "automatic",
          detail: "Public pages only; robots rules and private-network protection enforced.",
        },
        {
          id: "brave_search",
          name: "Brave Search API",
          mode: "automatic",
          detail:
            "Licensed web-index results propose official domains; only high-confidence, separated matches can auto-apply.",
        },
        {
          id: "ats",
          name: "Greenhouse, Lever, and Ashby",
          mode: "automatic",
          detail: "Published job-board APIs.",
        },
        {
          id: "datasf",
          name: "DataSF",
          mode: "automatic",
          detail: "Public-domain registered-business seed data for San Francisco.",
        },
        {
          id: "hackernews",
          name: "Hacker News",
          mode: "signal_only",
          detail: "Hiring signal only; emails in threads are not collected.",
        },
        {
          id: "apollo",
          name: "Apollo",
          mode: "automatic",
          detail:
            "Owner-configured licensed API for company discovery and targeted decision-maker enrichment.",
        },
        {
          id: "hunter",
          name: "Hunter",
          mode: "manual",
          detail:
            "Owner-triggered licensed finder and verifier for the selected person only.",
        },
        {
          id: "zerobounce",
          name: "ZeroBounce",
          mode: "manual",
          detail:
            "Optional owner-triggered second verifier; inactive without a configured key.",
        },
        {
          id: "csv",
          name: "CSV import",
          mode: "manual",
          detail:
            "Owner-supplied licensed seed data; imported verification labels are never trusted.",
        },
        {
          id: "yc",
          name: "Y Combinator",
          mode: "manual",
          detail: "Open the public directory for manual research; no automated directory scraping.",
        },
        {
          id: "linkedin",
          name: "LinkedIn",
          mode: "manual",
          detail: "Open a search and paste manually confirmed profile URLs; no cookie or profile scraping.",
        },
      ],
    }),
  );

  app.onError((error, c) => {
    if (!(error instanceof AppError)) console.error(error);
    const status = error instanceof AppError ? error.status : 500;
    const message =
      error instanceof AppError
        ? error.message
        : "An unexpected error occurred.";
    const code =
      error instanceof AppError ? error.code : "internal_error";
    return c.json({ error: message, code }, status as 400 | 500);
  });

  app.notFound((c) => c.json({ error: "Not found." }, 404));
  return app;
}

export type RecruitAiApp = ReturnType<typeof createApp>;
