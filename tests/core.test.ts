import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Papa from "papaparse";
import { createHash } from "node:crypto";
import {
  createApp,
  isAllowedLoopbackHost,
} from "../src/server/app";
import { createContactsCsv } from "../src/server/csv";
import { getBackupFile, inspectBackup } from "../src/server/dataManagement";
import { closeDatabase, getDatabase } from "../src/server/database";
import { importCsv } from "../src/server/discovery";
import { generateDraft } from "../src/server/drafting";
import { sendApprovedDraft } from "../src/server/gmail";
import {
  getDatabasePath,
  getSnapshotsDir,
} from "../src/server/paths";
import {
  addContact,
  addEvidence,
  addSuppression,
  claimDraftForSend,
  createSourceRun,
  finishSourceRun,
  getCompany,
  getDraft,
  isSuppressed,
  listDrafts,
  listSourceRuns,
  markDraftSent,
  markDraftSendUnknown,
  patchContact,
  patchCompany,
  patchDraft,
  recordDraftOutcome,
  recordReview,
  recomputeCompanyStats,
  saveSetting,
  upsertCompany,
  upsertJob,
} from "../src/server/repository";
import { saveSecrets } from "../src/server/secrets";
import {
  assertPublicWebsiteUrl,
  isBlockedNetworkAddress,
} from "../src/server/sources/website";

let testDataDir = "";
let originalDataDir: string | undefined;

beforeEach(() => {
  originalDataDir = process.env.RECRUITAI_DATA_DIR;
  testDataDir = mkdtempSync(path.join(tmpdir(), "recruit-ai-test-"));
  closeDatabase();
  process.env.RECRUITAI_DATA_DIR = testDataDir;
  getDatabase();
});

afterEach(() => {
  closeDatabase();
  if (originalDataDir === undefined) {
    delete process.env.RECRUITAI_DATA_DIR;
  } else {
    process.env.RECRUITAI_DATA_DIR = originalDataDir;
  }
  if (testDataDir.startsWith(path.join(tmpdir(), "recruit-ai-test-"))) {
    rmSync(testDataDir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 50,
    });
  }
});

function apiMutation(
  app: ReturnType<typeof createApp>,
  route: string,
  body?: unknown,
  method = "POST",
) {
  return app.request(`http://localhost${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-RecruitAI-Client": "1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function configureGmailForTests() {
  saveSecrets({
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh-token",
  });
  const settings: Record<string, unknown> = {
    sender_name: "Shaw",
    postal_address: "123 Test Street, San Francisco, CA 94107",
    opt_out_text: "Reply no thanks and I will not follow up.",
    compliance_confirmed: true,
    gmail_sending_enabled: true,
    gmail_hourly_cap: 20,
    gmail_daily_cap: 400,
    sending_window_start: 0,
    sending_window_end: 24,
    sending_days: [0, 1, 2, 3, 4, 5, 6],
    time_zone: "UTC",
    gmail_account_email: "sender@gmail.com",
    gmail_test_passed_at: new Date().toISOString(),
    emailFreshnessDays: 30,
  };
  for (const [key, value] of Object.entries(settings)) saveSetting(key, value);
}

function createQualifiedCompany(name: string, domain: string) {
  const company = upsertCompany({
    name,
    domain,
    location: "San Francisco, CA",
    employeeCountMin: 8,
    employeeCountMax: 35,
    industries: ["Artificial Intelligence"],
  });
  addEvidence({
    entityType: "company",
    entityId: company.id,
    fieldName: "website",
    value: `https://${domain}`,
    sourceType: "test_fixture",
    sourceLabel: "Test company source",
    sourceUrl: `https://${domain}`,
    confidence: 0.9,
  });
  patchCompany(company.id, {
    fitConfirmed: true,
    recruitingFit: "likely",
    recruitingFitNote: "Founder-led hiring and no internal recruiter listed.",
  });
  upsertJob({
    companyId: company.id,
    externalId: `${domain}-role`,
    title: "Machine Learning Engineer",
    sourceType: "greenhouse",
    postedAt: new Date().toISOString(),
  });
  return company.id;
}

function approveEditedDraft(companyId: string, contactId: string) {
  const draft = generateDraft(companyId, contactId, "concise");
  if (!draft) throw new Error("Draft was not created.");
  patchDraft(draft.id, {
    body: `${draft.body.replace("[Your name]", "Shaw")}\n\nWould a short introduction be useful?`,
  });
  const approved = patchDraft(draft.id, { status: "approved" });
  if (!approved) throw new Error("Draft was not approved.");
  return approved;
}

async function withMockedGmailSend<T>(action: () => Promise<T>) {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "test-access-token" });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      return Response.json({ id: "gmail-message-id", threadId: "gmail-thread-id" });
    }
    throw new Error(`Unexpected test request: ${url}`);
  }) as typeof fetch;
  try {
    return { result: await action(), requests };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("local service and public-network boundaries", () => {
  test("keeps the local data directory and database owner-only on POSIX", () => {
    if (process.platform === "win32") return;
    expect(statSync(testDataDir).mode & 0o777).toBe(0o700);
    expect(statSync(getDatabasePath()).mode & 0o777).toBe(0o600);
    expect(statSync(getSnapshotsDir()).mode & 0o777).toBe(0o700);
  });

  test("accepts only exact loopback hosts and rejects rebinding origins", async () => {
    expect(isAllowedLoopbackHost("127.0.0.1:4317")).toBe(true);
    expect(isAllowedLoopbackHost("localhost:5173")).toBe(true);
    expect(isAllowedLoopbackHost("[::1]:4317")).toBe(true);
    expect(isAllowedLoopbackHost("127.0.0.1.example.com:4317")).toBe(false);
    expect(isAllowedLoopbackHost("attacker.example:4317")).toBe(false);

    const app = createApp();
    const badHost = await app.request("http://attacker.example/api/health", {
      headers: { Host: "attacker.example:4317" },
    });
    expect(badHost.status).toBe(403);
    const badOrigin = await app.request("http://127.0.0.1/api/health", {
      headers: {
        Host: "127.0.0.1:4317",
        Origin: "https://attacker.example",
      },
    });
    expect(badOrigin.status).toBe(403);
  });

  test("blocks private, mapped, carrier, reserved, and local-name crawler targets", async () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.42.0.1",
      "169.254.169.254",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
    ]) {
      expect(isBlockedNetworkAddress(address)).toBe(true);
    }
    expect(isBlockedNetworkAddress("8.8.8.8")).toBe(false);
    expect(isBlockedNetworkAddress("2606:4700:4700::1111")).toBe(false);

    await expect(
      assertPublicWebsiteUrl(new URL("http://2130706433/")),
    ).rejects.toThrow("non-public");
    await expect(
      assertPublicWebsiteUrl(new URL("http://[::ffff:127.0.0.1]/")),
    ).rejects.toThrow("non-public");
    await expect(
      assertPublicWebsiteUrl(new URL("https://intranet/")),
    ).rejects.toThrow("Local network");
    await expect(
      assertPublicWebsiteUrl(new URL("https://service.internal/")),
    ).rejects.toThrow("Local network");
    await expect(
      assertPublicWebsiteUrl(new URL("https://user:pass@example.com/")),
    ).rejects.toThrow("credentials");
  });
});

describe("CSV contact export", () => {
  test("uses stable columns and neutralizes spreadsheet formulas", () => {
    const company = upsertCompany({
      name: "=ACME Labs",
      domain: "acme.test",
      location: "San Francisco, CA",
      industries: ["AI", "Robotics"],
    });
    patchCompany(company.id, { notes: " \t@review this record" });
    const contact = addContact(company.id, {
      fullName: "-Taylor Example",
      title: "+Chief Operating Officer",
      email: "taylor@acme.test",
      emailType: "work",
      emailStatus: "valid",
      phone: "+14155550199",
      phoneConfirmed: true,
      phoneSource: "Confirmed manually against the company directory.",
      reviewed: true,
    });
    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "website",
      sourceType: "test",
      sourceLabel: "Company site",
      sourceUrl: "https://acme.test/about",
    });

    const csv = createContactsCsv();
    const parsed = Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: true,
    });

    expect(parsed.errors).toEqual([]);
    expect(parsed.meta.fields).toEqual([
      "company_id",
      "company_name",
      "domain",
      "website_url",
      "location",
      "employee_count_min",
      "employee_count_max",
      "industries",
      "stage",
      "company_description",
      "fit_confirmed",
      "recruiting_fit",
      "recruiting_fit_note",
      "exclusion_reason",
      "exclusion_note",
      "hiring_score",
      "hiring_live_score",
      "hiring_freshness_score",
      "company_fit_score",
      "external_help_score",
      "evidence_quality_score",
      "open_roles_count",
      "fresh_roles_count",
      "conflict_count",
      "open_role_titles",
      "open_role_urls",
      "latest_job_seen_at",
      "priority",
      "company_status",
      "company_reviewed",
      "company_linkedin_url",
      "yc_url",
      "company_notes",
      "last_researched_at",
      "company_suppressed",
      "contact_id",
      "full_name",
      "title",
      "role_category",
      "email",
      "email_type",
      "fallback_reason",
      "fallback_confirmed",
      "email_status",
      "email_verified_at",
      "phone",
      "phone_type",
      "phone_confirmed",
      "phone_source",
      "contact_linkedin_url",
      "employment_confirmed",
      "observed_title",
      "employment_observed_at",
      "contact_rank",
      "contact_status",
      "contact_reviewed",
      "contact_notes",
      "contact_suppressed",
      "source_labels",
      "evidence_count",
      "evidence_urls",
      "last_outreach_status",
      "last_outreach_at",
    ]);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]).toMatchObject({
      company_id: company.id,
      company_name: "'=ACME Labs",
      industries: "AI; Robotics",
      company_notes: "' \t@review this record",
      contact_id: contact?.id,
      full_name: "'-Taylor Example",
      title: "'+Chief Operating Officer",
      email: "taylor@acme.test",
      phone: "'+14155550199",
      evidence_urls: "https://acme.test/about",
    });
    expect(csv).toContain("\r\n");
  });
});

describe("local API settings validation", () => {
  test("rejects unsafe limits and cross-field ranges before persisting settings", async () => {
    const app = createApp();
    const patchSettings = (body: unknown) =>
      app.request("http://localhost/api/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-RecruitAI-Client": "1",
        },
        body: JSON.stringify(body),
      });

    expect((await patchSettings({ gmail_hourly_cap: 21 })).status).toBe(400);
    expect(
      (await patchSettings({ employeeMin: 500, employeeMax: 100 })).status,
    ).toBe(400);
    expect(
      (
        await patchSettings({
          sending_window_start: 20,
          sending_window_end: 8,
        })
      ).status,
    ).toBe(400);
    expect((await patchSettings({ unsupported_setting: true })).status).toBe(
      400,
    );

    const accepted = await patchSettings({
      employeeMin: "3",
      employeeMax: "1000",
      gmail_hourly_cap: "20",
      gmail_daily_cap: "400",
      sending_window_start: "0",
      sending_window_end: "24",
    });
    const payload = (await accepted.json()) as {
      data: Record<string, unknown>;
    };
    expect(accepted.status).toBe(200);
    expect(payload.data).toMatchObject({
      employeeMin: 3,
      employeeMax: 1_000,
      gmail_hourly_cap: 20,
      gmail_daily_cap: 400,
      sending_window_start: 0,
      sending_window_end: 24,
    });
  });

  test("keeps Gmail sending locked until a test message succeeds", async () => {
    const app = createApp();
    saveSecrets({
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_REFRESH_TOKEN: "test-refresh-token",
    });
    const requiredSettings: Record<string, unknown> = {
      sender_name: "Shaw",
      postal_address: "123 Test Street, San Francisco, CA 94107",
      opt_out_text: "Reply no thanks and I will not follow up.",
      compliance_confirmed: true,
      gmail_account_email: "sender@gmail.com",
      gmail_sending_enabled: false,
    };
    for (const [key, value] of Object.entries(requiredSettings)) {
      saveSetting(key, value);
    }

    const locked = await apiMutation(
      app,
      "/api/settings",
      { gmail_sending_enabled: true },
      "PATCH",
    );
    const lockedPayload = (await locked.json()) as { error: string };
    expect(locked.status).toBe(400);
    expect(lockedPayload.error).toContain("successful test message");

    const tested = await withMockedGmailSend(async () =>
      await apiMutation(app, "/api/gmail/test"),
    );
    const testPayload = (await tested.result.json()) as {
      data: { ok: boolean; messageId: string; sentTo: string };
    };
    expect(tested.result.status).toBe(200);
    expect(testPayload.data).toMatchObject({
      ok: true,
      messageId: "gmail-message-id",
      sentTo: "sender@gmail.com",
    });
    expect(tested.requests).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    ]);

    const enabled = await apiMutation(
      app,
      "/api/settings",
      { gmail_sending_enabled: true },
      "PATCH",
    );
    const enabledPayload = (await enabled.json()) as {
      data: Record<string, unknown>;
    };
    expect(enabled.status).toBe(200);
    expect(enabledPayload.data.gmail_sending_enabled).toBe(true);
    expect(typeof enabledPayload.data.gmail_test_passed_at).toBe("string");
  });
});

describe("local data management", () => {
  test("backs up, inspects, restores, and compacts a complete local workspace", async () => {
    const app = createApp();
    const company = upsertCompany({
      name: "Backup Roundtrip Labs",
      domain: "backup-roundtrip-labs.com",
    });
    patchCompany(company.id, { notes: "Original local record." });
    const snapshotContent = "original snapshot";
    const snapshotName = `${createHash("sha256").update(snapshotContent).digest("hex")}.html`;
    const snapshotPath = path.join(getSnapshotsDir(), snapshotName);
    const extraSnapshotContent = "not in backup";
    const extraSnapshotPath = path.join(
      getSnapshotsDir(),
      `${createHash("sha256").update(extraSnapshotContent).digest("hex")}.html`,
    );
    writeFileSync(snapshotPath, snapshotContent, "utf8");
    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "website",
      sourceType: "test",
      sourceLabel: "Roundtrip snapshot",
      screenshotPath: snapshotPath,
    });

    const backupResponse = await apiMutation(app, "/api/data/backup");
    const backupPayload = (await backupResponse.json()) as {
      data: {
        fileName: string;
        snapshotCount: number;
        downloadUrl: string;
      };
    };
    expect(backupResponse.status).toBe(201);
    expect(backupPayload.data.snapshotCount).toBe(1);
    const download = await app.request(backupPayload.data.downloadUrl);
    expect(download.status).toBe(200);
    const backupText = await download.text();

    const inspectResponse = await apiMutation(
      app,
      "/api/data/backup/inspect",
      { backupText },
    );
    const inspected = (await inspectResponse.json()) as {
      data: {
        format: string;
        version: number;
        databaseBytes: number;
        snapshotCount: number;
      };
    };
    expect(inspectResponse.status).toBe(200);
    expect(inspected.data).toMatchObject({
      format: "recruitai-local-backup",
      version: 1,
      snapshotCount: 1,
    });
    expect(inspected.data.databaseBytes).toBeGreaterThan(100);

    patchCompany(company.id, { notes: "Mutated after backup." });
    writeFileSync(extraSnapshotPath, extraSnapshotContent, "utf8");
    const wrongConfirmation = await apiMutation(app, "/api/data/restore", {
      backupText,
      confirmation: "RESTORE",
    });
    expect(wrongConfirmation.status).toBe(400);
    expect(getCompany(company.id)?.notes).toBe("Mutated after backup.");

    const restoreResponse = await apiMutation(app, "/api/data/restore", {
      backupText,
      confirmation: "RESTORE LOCAL DATA",
    });
    expect(restoreResponse.status).toBe(200);
    expect(getCompany(company.id)?.notes).toBe("Original local record.");
    expect(readFileSync(snapshotPath, "utf8")).toBe("original snapshot");
    expect(existsSync(extraSnapshotPath)).toBe(false);

    const compactResponse = await apiMutation(app, "/api/data/compact");
    const compacted = (await compactResponse.json()) as {
      data: { compactedAt: string; databaseBytes: number };
    };
    expect(compactResponse.status).toBe(200);
    expect(compacted.data.databaseBytes).toBeGreaterThan(0);
    expect(getCompany(company.id)?.name).toBe("Backup Roundtrip Labs");
  });

  test("rejects traversal in backup names and embedded snapshot paths", () => {
    expect(() => getBackupFile("../recruitai-backup-stolen.json")).toThrow(
      "Invalid backup file name.",
    );
    const unsafeBackup = JSON.stringify({
      format: "recruitai-local-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      appVersion: "0.1.0",
      databaseBase64: Buffer.alloc(256).toString("base64"),
      snapshots: [
        {
          path: "../outside.txt",
          contentBase64: Buffer.from("unsafe").toString("base64"),
        },
      ],
    });
    expect(() => inspectBackup(unsafeBackup)).toThrow(
      "The backup contains an unsafe snapshot path.",
    );
  });

  test("requires exact typed confirmation before clearing fictional demo data", async () => {
    const app = createApp();
    expect((await apiMutation(app, "/api/discovery/demo")).status).toBe(201);
    const realCompany = upsertCompany({
      name: "Retained Production Seed",
      domain: "retained-production-seed.com",
    });
    const demoCompany = getDatabase()
      .query("SELECT id FROM companies WHERE domain = ?")
      .get("northstar-robotics.example") as { id: string };
    const demoSnapshotContent = "fictional demo snapshot";
    const demoSnapshotPath = path.join(
      getSnapshotsDir(),
      `${createHash("sha256").update(demoSnapshotContent).digest("hex")}.html`,
    );
    const realSnapshotContent = "retained production snapshot";
    const realSnapshotPath = path.join(
      getSnapshotsDir(),
      `${createHash("sha256").update(realSnapshotContent).digest("hex")}.html`,
    );
    writeFileSync(demoSnapshotPath, demoSnapshotContent, "utf8");
    writeFileSync(realSnapshotPath, realSnapshotContent, "utf8");
    const demoEvidenceId = addEvidence({
      entityType: "company",
      entityId: demoCompany.id,
      fieldName: "demo_snapshot",
      sourceType: "demo",
      sourceLabel: "Fictional demo fixture",
      screenshotPath: demoSnapshotPath,
    });
    addEvidence({
      entityType: "company",
      entityId: realCompany.id,
      fieldName: "production_snapshot",
      sourceType: "test",
      sourceLabel: "Retained production evidence",
      screenshotPath: realSnapshotPath,
    });
    getDatabase()
      .query(
        `INSERT INTO audit_events (
          id, event_type, entity_type, entity_id, summary, created_at
        ) VALUES (?, 'demo.evidence_created', 'evidence', ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        demoEvidenceId,
        "Created fictional demo evidence",
        new Date().toISOString(),
      );
    const demoEntityIds = (
      getDatabase()
        .query(
          `SELECT id FROM companies WHERE domain LIKE '%.example'
           UNION SELECT contacts.id FROM contacts
             JOIN companies ON companies.id = contacts.company_id
             WHERE companies.domain LIKE '%.example'
           UNION SELECT jobs.id FROM jobs
             JOIN companies ON companies.id = jobs.company_id
             WHERE companies.domain LIKE '%.example'
           UNION SELECT evidence.id FROM evidence
             WHERE evidence.entity_id IN (
               SELECT id FROM companies WHERE domain LIKE '%.example'
               UNION SELECT contacts.id FROM contacts
                 JOIN companies ON companies.id = contacts.company_id
                 WHERE companies.domain LIKE '%.example'
               UNION SELECT jobs.id FROM jobs
                 JOIN companies ON companies.id = jobs.company_id
                 WHERE companies.domain LIKE '%.example'
             )`,
        )
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
    const demoAuditCount = () =>
      Number(
        (
          getDatabase()
            .query(
              `SELECT COUNT(*) AS count FROM audit_events
               WHERE entity_id IN (${demoEntityIds.map(() => "?").join(", ")})`,
            )
            .get(...demoEntityIds) as { count: number }
        ).count,
      );
    expect(demoAuditCount()).toBeGreaterThan(0);
    const beforeCount = (
      getDatabase().query("SELECT COUNT(*) AS count FROM companies").get() as {
        count: number;
      }
    ).count;

    const rejected = await apiMutation(app, "/api/data/clear-demo", {
      confirmation: "clear demo data",
    });
    expect(rejected.status).toBe(400);
    expect(
      (
        getDatabase().query("SELECT COUNT(*) AS count FROM companies").get() as {
          count: number;
        }
      ).count,
    ).toBe(beforeCount);

    const cleared = await apiMutation(app, "/api/data/clear-demo", {
      confirmation: "CLEAR DEMO DATA",
    });
    const payload = (await cleared.json()) as {
      data: {
        removedCompanies: number;
        removedAuditEvents: number;
        removedSnapshots: number;
      };
    };
    expect(cleared.status).toBe(200);
    expect(payload.data.removedCompanies).toBe(3);
    expect(payload.data.removedAuditEvents).toBeGreaterThan(0);
    expect(payload.data.removedSnapshots).toBe(1);
    expect(getCompany(realCompany.id)?.name).toBe("Retained Production Seed");
    expect(demoAuditCount()).toBe(0);
    expect(
      (
        getDatabase()
          .query(
            "SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ?",
          )
          .get(realCompany.id) as { count: number }
      ).count,
    ).toBeGreaterThan(0);
    expect(existsSync(demoSnapshotPath)).toBe(false);
    expect(existsSync(realSnapshotPath)).toBe(true);
    expect(
      (
        getDatabase()
          .query("SELECT COUNT(*) AS count FROM companies WHERE domain LIKE '%.example'")
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });

  test("requires exact typed confirmation and creates recovery backup before delete-all", async () => {
    const app = createApp();
    const company = upsertCompany({
      name: "Delete-All Recovery Labs",
      domain: "delete-all-recovery-labs.com",
    });
    const snapshotContent = "recovery data";
    const snapshotPath = path.join(
      getSnapshotsDir(),
      `${createHash("sha256").update(snapshotContent).digest("hex")}.html`,
    );
    writeFileSync(snapshotPath, snapshotContent, "utf8");
    addSuppression(
      "blocked@delete-all-recovery-labs.com",
      "email",
      "Test suppression",
    );
    const activeRun = createSourceRun("test-source", { page: 1 });

    const rejected = await apiMutation(app, "/api/data/delete-all", {
      confirmation: "DELETE ALL",
    });
    expect(rejected.status).toBe(400);
    expect(getCompany(company.id)).not.toBeNull();
    expect(existsSync(snapshotPath)).toBe(true);

    const blockedWhileResearching = await apiMutation(
      app,
      "/api/data/delete-all",
      {
        confirmation: "DELETE LOCAL DATA",
      },
    );
    expect(blockedWhileResearching.status).toBe(409);
    expect(
      ((await blockedWhileResearching.json()) as { code: string }).code,
    ).toBe("active_research");
    expect(getCompany(company.id)).not.toBeNull();

    finishSourceRun(activeRun.id, {
      inserted: 0,
      updated: 0,
      skipped: 0,
    });
    const deleted = await apiMutation(app, "/api/data/delete-all", {
      confirmation: "DELETE LOCAL DATA",
    });
    const payload = (await deleted.json()) as {
      data: { recoveryBackup: string; deletedAt: string };
    };
    expect(deleted.status).toBe(200);
    expect(payload.data.recoveryBackup).toMatch(
      /^recruitai-backup-.+\.json$/,
    );
    expect(getBackupFile(payload.data.recoveryBackup).fileName).toBe(
      payload.data.recoveryBackup,
    );
    expect(getCompany(company.id)).toBeNull();
    expect(listSourceRuns()).toEqual([]);
    expect(
      isSuppressed("blocked@delete-all-recovery-labs.com", "email"),
    ).toBe(false);
    expect(existsSync(snapshotPath)).toBe(false);

    const statusResponse = await app.request("/api/data/status");
    const status = (await statusResponse.json()) as {
      data: {
        counts: {
          companies: number;
          contacts: number;
          jobs: number;
          evidence: number;
        };
      };
    };
    expect(status.data.counts).toEqual({
      companies: 0,
      contacts: 0,
      jobs: 0,
      evidence: 0,
    });
  });
});

describe("contact provenance", () => {
  test("stores phone numbers only with explicit confirmation and a source", () => {
    const company = upsertCompany({
      name: "Manual Contact Labs",
      domain: "manual-contact.test",
    });
    expect(() =>
      addContact(company.id, {
        fullName: "Avery Stone",
        phone: "+14155550101",
      }),
    ).toThrow(
      "A manually added phone requires confirmation and a source URL or note.",
    );

    const contact = addContact(company.id, {
      fullName: "Avery Stone",
      title: "Founder",
    });
    expect(() =>
      patchContact(contact!.id, {
        phone: "+14155550101",
        phoneConfirmed: true,
      }),
    ).toThrow(
      "A manually added phone requires confirmation and a source URL or note.",
    );

    const confirmed = patchContact(contact!.id, {
      phone: "+14155550101",
      phoneType: "business",
      phoneConfirmed: true,
      phoneSource: "Confirmed on the company contact page.",
    });
    expect(confirmed).toMatchObject({
      phone: "+14155550101",
      phoneType: "business",
      phoneConfirmed: true,
      phoneSource: "Confirmed on the company contact page.",
    });
  });
});

describe("source-run idempotency", () => {
  test("reuses an active canonical request and permits a later completed rerun", () => {
    const first = createSourceRun("datasf", {
      technologyOnly: true,
      filters: { employeeMax: 1_000, employeeMin: 3 },
      limit: 500,
    });
    const duplicate = createSourceRun("datasf", {
      limit: 500,
      filters: { employeeMin: 3, employeeMax: 1_000 },
      technologyOnly: true,
    });
    const distinct = createSourceRun("datasf", {
      limit: 250,
      technologyOnly: true,
      filters: { employeeMin: 3, employeeMax: 1_000 },
    });

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ id: first.id, created: false });
    expect(distinct.created).toBe(true);
    expect(
      listSourceRuns().find((run) => run.id === first.id)?.status,
    ).toBe("queued");

    finishSourceRun(first.id, { inserted: 2, updated: 1, skipped: 0 });
    const rerun = createSourceRun("datasf", {
      filters: { employeeMax: 1_000, employeeMin: 3 },
      technologyOnly: true,
      limit: 500,
    });
    expect(rerun.created).toBe(true);
    expect(rerun.id).not.toBe(first.id);
  });
});

describe("CSV import aliases", () => {
  test("rejects malformed structure and ambiguous owner mappings before writing", async () => {
    expect(() =>
      importCsv(
        'company_name,website_url\n"Broken company,https://broken.test',
        "Broken CSV",
      ),
    ).toThrow("CSV is malformed");
    expect(() =>
      importCsv(
        "company_name, company_name\nFirst,Second",
        "Duplicate headers",
      ),
    ).toThrow("unique header");
    expect(() =>
      importCsv(
        "company_name,website_url\nMapped,https://mapped.test",
        "Unknown mapping",
        {
          Missing: "company_name",
        },
      ),
    ).toThrow("unknown column");
    expect(() =>
      importCsv(
        "company_name,website_url\nMapped,https://mapped.test",
        "Duplicate mapping",
        {
          company_name: "company_name",
          website_url: "company_name",
        },
      ),
    ).toThrow("only one CSV column");
    expect(
      (
        getDatabase()
          .query("SELECT COUNT(*) AS count FROM companies")
          .get() as { count: number }
      ).count,
    ).toBe(0);

    const app = createApp();
    const response = await apiMutation(app, "/api/discovery/import", {
      csv: "company_name,website_url\nMapped,https://mapped.test",
      sourceLabel: "Missing company mapping",
      mapping: { website_url: "website_url" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_csv_mapping",
    });
  });

  test("maps common company/contact headers and discards unconfirmed phones", () => {
    const csv = [
      "Organization,Company URL,City,Company Size,Industries,Contact,Role,Email,Phone,Phone Confirmed,Phone Source,Profile URL",
      '"Alias Robotics",https://alias-robotics.test,Oakland,3-10,"AI; Robotics","Dana Park",CEO,dana@alias-robotics.test,+14155550102,yes,https://alias-robotics.test/contact,https://linkedin.test/in/dana',
      '"Unsafe Phone Labs",https://unsafe-phone.test,"San Francisco",11-50,Data,"Sam Ortiz",COO,sam@unsafe-phone.test,+14155550103,no,,https://linkedin.test/in/sam',
    ].join("\n");

    const imported = importCsv(csv, "Alias coverage");
    expect(imported).toMatchObject({
      inserted: 2,
      updated: 0,
      skipped: 0,
      contacts: 2,
      parseWarnings: [],
    });

    const aliasId = (
      getDatabase()
        .query("SELECT id FROM companies WHERE normalized_name = ?")
        .get("alias robotics") as { id: string }
    ).id;
    const unsafeId = (
      getDatabase()
        .query("SELECT id FROM companies WHERE normalized_name = ?")
        .get("unsafe phone labs") as { id: string }
    ).id;
    const alias = getCompany(aliasId);
    const unsafe = getCompany(unsafeId);

    expect(alias).toMatchObject({
      websiteUrl: "https://alias-robotics.test",
      location: "Oakland",
      employeeCountMin: 3,
      employeeCountMax: 10,
      industries: ["AI", "Robotics"],
    });
    expect(alias?.contacts[0]).toMatchObject({
      fullName: "Dana Park",
      title: "CEO",
      email: "dana@alias-robotics.test",
      emailStatus: "unverified",
      phone: "+14155550102",
      phoneConfirmed: true,
      phoneSource: "https://alias-robotics.test/contact",
      linkedinUrl: "https://linkedin.test/in/dana",
    });
    expect(unsafe?.contacts[0]).toMatchObject({
      fullName: "Sam Ortiz",
      phone: null,
      phoneConfirmed: false,
    });
  });

  test("preserves owner state and records source notes on identical re-import", () => {
    const csv = [
      "company_name,domain,location,company_size,stage,notes,source_url",
      '"Reimport AI",reimport-ai.test,"San Francisco, CA",10-25,Seed,"Provider research note.",https://reimport-ai.test/about',
    ].join("\n");

    expect(importCsv(csv, "Owner-state regression")).toMatchObject({
      inserted: 1,
      updated: 0,
      skipped: 0,
    });
    const companyId = (
      getDatabase()
        .query("SELECT id FROM companies WHERE domain = ?")
        .get("reimport-ai.test") as { id: string }
    ).id;
    expect(getCompany(companyId)).toMatchObject({
      status: "needs_research",
      reviewed: false,
      notes: null,
    });

    patchCompany(companyId, {
      status: "new",
      reviewed: true,
      notes: "Owner-curated research and decision notes.",
    });
    expect(importCsv(csv, "Owner-state regression")).toMatchObject({
      inserted: 0,
      updated: 1,
      skipped: 0,
    });

    const current = getCompany(companyId);
    expect(current).toMatchObject({
      status: "new",
      reviewed: true,
      notes: "Owner-curated research and decision notes.",
    });
    const sourceNotes =
      current?.evidence.filter((item) => item.fieldName === "source_note") || [];
    expect(sourceNotes).toHaveLength(2);
    expect(
      sourceNotes.every(
        (item) =>
          item.value === "Provider research note." &&
          item.sourceUrl === "https://reimport-ai.test/about",
      ),
    ).toBe(true);
  });

  test("preserves reviewed facts and notes while changed re-imports become conflicts", () => {
    const originalCsv = [
      "company_name,domain,location,company_size,stage,notes",
      '"Conflict Robotics",conflict-robotics.test,"San Francisco, CA",10-20,Seed,"Initial provider note."',
    ].join("\n");
    importCsv(originalCsv, "Changed re-import regression");
    const companyId = (
      getDatabase()
        .query("SELECT id FROM companies WHERE domain = ?")
        .get("conflict-robotics.test") as { id: string }
    ).id;
    patchCompany(companyId, {
      location: "Oakland, CA",
      employeeCountMin: 12,
      employeeCountMax: 18,
      stage: "Bootstrapped",
      status: "approved",
      reviewed: true,
      notes: "Owner confirmed these facts directly with the founder.",
    });

    const changedCsv = [
      "company_name,domain,location,company_size,stage,notes",
      '"Conflict Robotics",conflict-robotics.test,"Berkeley, CA",40-60,"Series A","Updated provider note."',
    ].join("\n");
    expect(importCsv(changedCsv, "Changed re-import regression")).toMatchObject({
      inserted: 0,
      updated: 1,
      skipped: 0,
    });

    const current = getCompany(companyId);
    expect(current).toMatchObject({
      location: "Oakland, CA",
      employeeCountMin: 12,
      employeeCountMax: 18,
      stage: "Bootstrapped",
      notes: "Owner confirmed these facts directly with the founder.",
      status: "ready_for_review",
      reviewed: false,
    });
    expect(
      current?.conflicts
        .filter((item) => item.status === "open")
        .map((item) => ({
          fieldName: item.fieldName,
          currentValue: item.currentValue,
          candidateValue: item.candidateValue,
        })),
    ).toEqual(
      expect.arrayContaining([
        {
          fieldName: "location",
          currentValue: "Oakland, CA",
          candidateValue: "Berkeley, CA",
        },
        {
          fieldName: "employee_count",
          currentValue: "12–18",
          candidateValue: "40–60",
        },
        {
          fieldName: "stage",
          currentValue: "Bootstrapped",
          candidateValue: "Series A",
        },
      ]),
    );
    expect(
      current?.evidence.some(
        (item) =>
          item.fieldName === "source_note" &&
          item.value === "Updated provider note.",
      ),
    ).toBe(true);
  });

  test("applies an explicit owner-reviewed column mapping through the API", async () => {
    const app = createApp();
    const csv = [
      "Startup Label,Homepage,Headcount,Decision Owner,Owner Role,Work Address",
      "Mapped Compute,https://mapped-compute.com,7-22,Taylor Kim,COO,taylor@mapped-compute.com",
    ].join("\n");
    const response = await apiMutation(app, "/api/discovery/import", {
      csv,
      sourceLabel: "Mapped owner CSV",
      mapping: {
        "Startup Label": "company_name",
        Homepage: "website_url",
        Headcount: "company_size",
        "Decision Owner": "full_name",
        "Owner Role": "title",
        "Work Address": "email",
      },
    });
    const payload = (await response.json()) as {
      data: { inserted: number; contacts: number; parseWarnings: string[] };
    };
    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      inserted: 1,
      contacts: 1,
      parseWarnings: [],
    });

    const row = getDatabase()
      .query("SELECT id FROM companies WHERE domain = ?")
      .get("mapped-compute.com") as { id: string };
    expect(getCompany(row.id)).toMatchObject({
      name: "Mapped Compute",
      websiteUrl: "https://mapped-compute.com",
      employeeCountMin: 7,
      employeeCountMax: 22,
      contacts: [
        {
          fullName: "Taylor Kim",
          title: "COO",
          email: "taylor@mapped-compute.com",
          emailStatus: "unverified",
        },
      ],
    });
  });
});

describe("API input boundaries", () => {
  test("rejects invalid draft pagination, oversized contacts, and ambiguous patches", async () => {
    const app = createApp();
    const invalidDraftQueries = [
      "/api/outreach/drafts?limit=-1",
      "/api/outreach/drafts?offset=nope",
      "/api/outreach/drafts?view=typo",
      "/api/outreach/drafts?unknown=true",
    ];
    for (const route of invalidDraftQueries) {
      const response = await app.request(`http://localhost${route}`);
      expect(response.status).toBe(400);
    }

    const company = upsertCompany({ name: "Input Boundary Labs" });
    const oversizedContact = await apiMutation(
      app,
      `/api/companies/${company.id}/contacts`,
      { fullName: "x".repeat(501) },
    );
    expect(oversizedContact.status).toBe(400);
    const invalidDomain = await apiMutation(
      app,
      `/api/companies/${company.id}`,
      { domain: "localhost" },
      "PATCH",
    );
    expect(invalidDomain.status).toBe(400);

    const contact = addContact(company.id, {
      fullName: "Boundary Owner",
      title: "CEO",
      status: "primary",
    });
    const draft = generateDraft(company.id, contact!.id, "concise");
    const emptyPatch = await apiMutation(
      app,
      `/api/outreach/drafts/${draft!.id}`,
      {},
      "PATCH",
    );
    expect(emptyPatch.status).toBe(400);
    const unknownDomainOption = await apiMutation(
      app,
      `/api/companies/${company.id}/research/domain`,
      { autoApplyHighConfidence: false, unexpected: true },
    );
    expect(unknownDomainOption.status).toBe(400);
  });
});

describe("outreach safety gates", () => {
  test("requires confirmed employment, the current primary, and documented fallback email", async () => {
    configureGmailForTests();
    const companyId = createQualifiedCompany(
      "Fallback Route Robotics",
      "fallback-route-robotics.com",
    );
    const contact = addContact(companyId, {
      fullName: "Riley Chen",
      title: "Founder and CEO",
      email: "riley.fallback@gmail.com",
      emailType: "personal",
      emailStatus: "valid",
      emailVerifiedAt: new Date().toISOString(),
      status: "primary",
      reviewed: true,
    });
    recordReview(companyId, "approved", "Company qualification complete.");
    const draft = approveEditedDraft(companyId, contact!.id);
    patchContact(contact!.id, { status: "alternate" });

    await expect(sendApprovedDraft(draft.id)).rejects.toThrow(
      "Manually confirm this decision-maker's current title and observed date",
    );
    patchContact(contact!.id, {
      employmentConfirmed: true,
      observedTitle: "Founder and CEO",
      employmentObservedAt: new Date().toISOString(),
      reviewed: true,
    });
    patchDraft(draft.id, { status: "approved" });
    await expect(sendApprovedDraft(draft.id)).rejects.toThrow(
      "Only the current primary decision-maker",
    );

    patchContact(contact!.id, { status: "primary" });
    recordReview(companyId, "approved", "Primary decision-maker selected.");
    patchDraft(draft.id, { status: "approved" });
    await expect(sendApprovedDraft(draft.id)).rejects.toThrow(
      "Document why a personal or generic address is the necessary fallback",
    );

    patchContact(contact!.id, {
      fallbackConfirmed: true,
      fallbackReason: "No work address was found after checking the company domain.",
    });
    patchDraft(draft.id, { status: "approved" });
    const sent = await withMockedGmailSend(() => sendApprovedDraft(draft.id));
    expect(sent.result).toMatchObject({ id: draft.id, status: "sent" });
    expect(sent.requests).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    ]);
  });

  test("waits for a recorded outcome before advancing to the next decision-maker", async () => {
    configureGmailForTests();
    saveSetting("no_response_wait_days", 1);
    const companyId = createQualifiedCompany(
      "Sequenced Outreach Systems",
      "sequenced-outreach-systems.com",
    );
    const observedAt = new Date().toISOString();
    const founder = addContact(companyId, {
      fullName: "Ari Patel",
      title: "Founder and CEO",
      email: "ari@sequenced-outreach-systems.com",
      emailType: "work",
      emailStatus: "valid",
      emailVerifiedAt: observedAt,
      employmentConfirmed: true,
      observedTitle: "Founder and CEO",
      employmentObservedAt: observedAt,
      status: "primary",
      reviewed: true,
      rank: 1,
    });
    recordReview(companyId, "approved", "Founder and company verified.");
    const founderDraft = approveEditedDraft(companyId, founder!.id);
    expect(claimDraftForSend(founderDraft.id)?.status).toBe("sending");
    expect(
      markDraftSent(founderDraft.id, "existing-gmail-message")?.status,
    ).toBe("sent");

    const operator = addContact(companyId, {
      fullName: "Morgan Lee",
      title: "Chief Operating Officer",
      email: "morgan@sequenced-outreach-systems.com",
      emailType: "work",
      emailStatus: "valid",
      emailVerifiedAt: observedAt,
      employmentConfirmed: true,
      observedTitle: "Chief Operating Officer",
      employmentObservedAt: observedAt,
      status: "primary",
      reviewed: true,
      rank: 2,
    });
    recordReview(companyId, "approved", "Advanced decision-maker verified.");
    const operatorDraft = approveEditedDraft(companyId, operator!.id);

    await expect(sendApprovedDraft(operatorDraft.id)).rejects.toThrow(
      "Resolve the existing sent outreach to Ari Patel",
    );
    expect(() =>
      recordDraftOutcome(founderDraft.id, "no_response", "No reply yet."),
    ).toThrow("Wait 1 days after sending");

    const oldSentAt = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    getDatabase()
      .query("UPDATE outreach_drafts SET sent_at = ? WHERE id = ?")
      .run(oldSentAt, founderDraft.id);
    expect(
      recordDraftOutcome(
        founderDraft.id,
        "no_response",
        "No response after the waiting period.",
      ),
    ).toMatchObject({
      id: founderDraft.id,
      status: "no_response",
      outcomeNote: "No response after the waiting period.",
    });

    const sent = await withMockedGmailSend(() =>
      sendApprovedDraft(operatorDraft.id),
    );
    expect(sent.result).toMatchObject({
      id: operatorDraft.id,
      status: "sent",
    });
    expect(getDraft(founderDraft.id)?.status).toBe("no_response");
  });
});

describe("tailored drafting", () => {
  test("uses hiring context and updates the existing contact draft", () => {
    const company = upsertCompany({
      name: "Orbital Forge",
      domain: "orbital-forge.test",
      employeeCountMin: 8,
      employeeCountMax: 16,
      industries: ["Robotics", "Manufacturing"],
    });
    const contact = addContact(company.id, {
      fullName: "Morgan Chen",
      title: "Founder and CEO",
      email: "morgan@orbital-forge.test",
      emailType: "work",
      status: "primary",
    });
    upsertJob({
      companyId: company.id,
      externalId: "robotics-engineer",
      title: "Robotics Engineer",
      sourceType: "company_site",
      postedAt: new Date().toISOString(),
    });

    const firstDraft = generateDraft(company.id, contact!.id, "founder");
    expect(firstDraft).toMatchObject({
      companyId: company.id,
      contactId: contact!.id,
      subject: "Help with Robotics Engineer at Orbital Forge",
      status: "draft",
    });
    expect(firstDraft?.body).toContain("Hi Morgan,");
    expect(firstDraft?.body).toContain("small team");
    expect(firstDraft?.body).toContain("your search for a Robotics Engineer");
    expect(firstDraft?.body).toContain("30% of first-year salary");
    expect(firstDraft?.editedAt).toBeNull();
    expect(() => patchDraft(firstDraft!.id, { status: "approved" })).toThrow(
      "Replace the [Your name] placeholder before approving this message.",
    );

    const editedDraft = patchDraft(firstDraft!.id, {
      body: `${firstDraft!.body.replace("[Your name]", "Shaw")}\n\nWould a brief introduction be useful?`,
    });
    expect(editedDraft?.editedAt).not.toBeNull();
    expect(editedDraft?.status).toBe("draft");
    expect(patchDraft(firstDraft!.id, { status: "approved" })?.status).toBe(
      "approved",
    );

    saveSetting("sender_name", "Shaw");
    const updatedDraft = generateDraft(company.id, contact!.id, "technical");
    expect(updatedDraft?.id).toBe(firstDraft?.id);
    expect(updatedDraft?.editedAt).toBeNull();
    expect(updatedDraft?.status).toBe("draft");
    expect(updatedDraft?.body).toContain(
      "Orbital Forge's work in Robotics and Manufacturing",
    );
    expect(updatedDraft?.body).toContain("Best,\nShaw");
    expect(() => patchDraft(updatedDraft!.id, { status: "approved" })).toThrow(
      "Edit this generated message before approving it.",
    );
    patchDraft(updatedDraft!.id, {
      body: `${updatedDraft!.body}\n\nCould we compare notes this week?`,
    });
    patchDraft(updatedDraft!.id, { status: "approved" });
    expect(claimDraftForSend(updatedDraft!.id)?.status).toBe("sending");
    expect(
      markDraftSendUnknown(
        updatedDraft!.id,
        "Connection closed after Gmail request started.",
      )?.status,
    ).toBe("send_unknown");
    expect(() => patchDraft(updatedDraft!.id, { status: "approved" })).toThrow(
      "immutable history",
    );
    expect(() => generateDraft(company.id, contact!.id, "concise")).toThrow(
      "delivery whose result is unresolved",
    );
    expect(listDrafts()).toHaveLength(1);
  });
});

describe("manual research workflows", () => {
  test("validates manual hiring evidence and resolves conflicting company facts", async () => {
    const app = createApp();
    const company = upsertCompany({
      name: "Manual Evidence Systems",
      domain: "manual-evidence-systems.com",
      location: "San Francisco, CA",
    });
    const observedAt = new Date().toISOString();

    const invalidJob = await apiMutation(
      app,
      `/api/companies/${company.id}/jobs/manual`,
      {
        title: "Founding Engineer",
        observedAt,
        confirmedLive: true,
        noPublicUrl: false,
      },
    );
    expect(invalidJob.status).toBe(400);

    const validJob = await apiMutation(
      app,
      `/api/companies/${company.id}/jobs/manual`,
      {
        title: "Founding Engineer",
        location: "San Francisco, CA",
        observedAt,
        excerpt: "Founder confirmed the role is actively open.",
        confirmedLive: true,
        noPublicUrl: true,
      },
    );
    const jobPayload = (await validJob.json()) as {
      data: NonNullable<ReturnType<typeof getCompany>>;
    };
    expect(validJob.status).toBe(201);
    expect(jobPayload.data).toMatchObject({
      openRolesCount: 1,
      jobs: [
        {
          title: "Founding Engineer",
          sourceType: "manual",
          confirmedLive: true,
          observedAt,
        },
      ],
    });
    expect(
      (
        getDatabase()
          .query(
            "SELECT COUNT(*) AS count FROM evidence WHERE source_type = 'manual' AND field_name = 'hiring'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);

    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "location",
      value: "Oakland, CA",
      sourceType: "test",
      sourceLabel: "Conflicting registry",
    });
    const conflicted = getCompany(company.id);
    expect(conflicted?.conflictCount).toBe(1);
    expect(conflicted?.conflicts[0]).toMatchObject({
      fieldName: "location",
      currentValue: "San Francisco, CA",
      candidateValue: "Oakland, CA",
      status: "open",
    });

    const missingNote = await apiMutation(
      app,
      `/api/conflicts/${conflicted!.conflicts[0].id}/resolve`,
      { resolution: "use_candidate", note: "" },
    );
    expect(missingNote.status).toBe(400);

    const resolved = await apiMutation(
      app,
      `/api/conflicts/${conflicted!.conflicts[0].id}/resolve`,
      {
        resolution: "use_candidate",
        note: "Registry is the newer confirmed headquarters source.",
      },
    );
    const resolvedPayload = (await resolved.json()) as {
      data: NonNullable<ReturnType<typeof getCompany>>;
    };
    expect(resolved.status).toBe(200);
    expect(resolvedPayload.data).toMatchObject({
      location: "Oakland, CA",
      conflictCount: 0,
      reviewed: false,
    });
    expect(resolvedPayload.data.conflicts[0]).toMatchObject({
      status: "resolved",
      resolution: "use_candidate",
    });
  });
});

describe("repository lifecycle", () => {
  test("requires explicit company fit and current hiring evidence before approval", () => {
    const company = upsertCompany({
      name: "Qualification Gate Labs",
      domain: "qualification-gate.test",
      location: "San Francisco, CA",
      employeeCountMin: 6,
      employeeCountMax: 18,
      industries: ["Machine Learning"],
    });
    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "website",
      value: "https://qualification-gate.test",
      sourceType: "test_fixture",
      sourceLabel: "Test company source",
      sourceUrl: "https://qualification-gate.test",
      confidence: 0.9,
    });

    expect(() =>
      recordReview(company.id, "approved", "Attempted early approval."),
    ).toThrow("Company fit, Hiring now");
    patchCompany(company.id, {
      fitConfirmed: true,
      recruitingFit: "likely",
      recruitingFitNote: "Founder-led hiring with no recruiter listed.",
    });
    expect(() =>
      recordReview(company.id, "approved", "Still missing a hiring signal."),
    ).toThrow("Hiring now");

    upsertJob({
      companyId: company.id,
      externalId: "founding-researcher",
      title: "Founding Research Engineer",
      sourceType: "ashby",
      postedAt: new Date().toISOString(),
    });
    expect(
      recordReview(company.id, "approved", "Qualification verified."),
    ).toMatchObject({
      fitConfirmed: true,
      recruitingFit: "likely",
      reviewed: true,
      status: "approved",
      openRolesCount: 1,
    });
  });

  test("treats Hacker News jobs as lead signals until hiring is confirmed", () => {
    const company = upsertCompany({
      name: "Lead Signal Labs",
      domain: "lead-signal.test",
      location: "San Francisco, CA",
      employeeCountMin: 5,
      employeeCountMax: 20,
      industries: ["Artificial Intelligence"],
    });
    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "website",
      value: "https://lead-signal.test",
      sourceType: "test_fixture",
      sourceLabel: "Test company source",
      sourceUrl: "https://lead-signal.test",
      confidence: 0.9,
    });
    patchCompany(company.id, {
      fitConfirmed: true,
      recruitingFit: "likely",
      recruitingFitNote: "Founder-led hiring with no recruiter listed.",
    });
    upsertJob({
      companyId: company.id,
      externalId: "hn-role",
      title: "AI Engineer",
      sourceType: "hackernews",
      postedAt: new Date().toISOString(),
    });

    expect(
      getCompany(company.id)?.readiness.find((item) => item.id === "hiring_now"),
    ).toMatchObject({
      state: "needs_attention",
      detail:
        "A lead-only hiring signal is current; confirm it on the company site, a supported ATS, or with a manual source review",
    });
    expect(() =>
      recordReview(company.id, "approved", "HN lead only."),
    ).toThrow("Hiring now");

    saveSetting("jobFreshnessDays", 30);
    saveSetting("jobRefreshDays", 365);
    const staleAtsJob = upsertJob({
      companyId: company.id,
      externalId: "stale-ats-role",
      title: "Research Engineer",
      sourceType: "greenhouse",
      postedAt: new Date(Date.now() - 100 * 86_400_000).toISOString(),
    });
    getDatabase()
      .query(
        `UPDATE jobs SET first_seen_at = ?, last_seen_at = ?
         WHERE id = ?`,
      )
      .run(
        new Date(Date.now() - 100 * 86_400_000).toISOString(),
        new Date(Date.now() - 100 * 86_400_000).toISOString(),
        staleAtsJob.id,
      );
    recomputeCompanyStats(company.id);
    expect(() =>
      recordReview(company.id, "approved", "HN current; ATS stale."),
    ).toThrow("Hiring now");

    upsertJob({
      companyId: company.id,
      externalId: "manual-confirmed-role",
      title: "AI Engineer",
      sourceType: "manual",
      confirmedLive: true,
      observedAt: new Date().toISOString(),
    });
    expect(
      recordReview(company.id, "approved", "Hiring confirmed manually."),
    ).toMatchObject({ status: "approved", reviewed: true });
  });

  test("deduplicates companies, contacts, and jobs before retaining review history", () => {
    const firstCompany = upsertCompany({
      name: "Signal Works",
      domain: "https://www.signal-works.test/jobs",
      location: "Oakland, CA",
      employeeCountMin: 12,
      employeeCountMax: 40,
      description: "Early-stage hardware company.",
      industries: ["Hardware"],
    });
    const mergedCompany = upsertCompany({
      name: "Signal Works, Inc.",
      websiteUrl: "https://signal-works.test",
      location: "San Francisco, CA",
      description:
        "Early-stage hardware and machine-learning company building novel sensing systems.",
      industries: ["Machine Learning"],
    });

    expect(firstCompany.inserted).toBe(true);
    expect(mergedCompany).toEqual({ id: firstCompany.id, inserted: false });
    addEvidence({
      entityType: "company",
      entityId: firstCompany.id,
      fieldName: "website",
      value: "https://signal-works.test",
      sourceType: "test_fixture",
      sourceLabel: "Test company source",
      sourceUrl: "https://signal-works.test",
      confidence: 0.9,
    });
    patchCompany(firstCompany.id, {
      fitConfirmed: true,
      recruitingFit: "likely",
      recruitingFitNote: "Small team with no internal recruiting function.",
    });

    const firstJob = upsertJob({
      companyId: firstCompany.id,
      externalId: "job-42",
      title: "Founding ML Engineer",
      sourceType: "greenhouse",
      postedAt: new Date().toISOString(),
    });
    const refreshedJob = upsertJob({
      companyId: firstCompany.id,
      externalId: "job-42",
      title: "Founding Machine Learning Engineer",
      sourceType: "greenhouse",
      postedAt: new Date().toISOString(),
    });
    expect(firstJob.inserted).toBe(true);
    expect(refreshedJob).toEqual({ id: firstJob.id, inserted: false });

    const firstContact = addContact(firstCompany.id, {
      fullName: "Alex Rivera",
      title: "Chief Operating Officer",
      email: "ALEX@SIGNAL-WORKS.TEST",
      emailType: "work",
      rank: 1,
    });
    const refreshedContact = addContact(firstCompany.id, {
      fullName: "Alex Rivera",
      title: "COO",
      email: "alex@signal-works.test",
      emailType: "work",
      emailStatus: "valid",
      reviewed: true,
      rank: 1,
    });
    expect(refreshedContact?.id).toBe(firstContact?.id);

    recordReview(
      firstCompany.id,
      "needs_research",
      "Confirm whether this leader still owns hiring.",
    );
    const reviewed = recordReview(
      firstCompany.id,
      "approved",
      "Hiring signal and decision-maker verified.",
    );
    const detail = getCompany(firstCompany.id);
    const reviewCount = getDatabase()
      .query("SELECT COUNT(*) AS count FROM reviews WHERE company_id = ?")
      .get(firstCompany.id) as { count: number };

    expect(reviewed).toMatchObject({
      reviewed: true,
      status: "approved",
      notes: "Hiring signal and decision-maker verified.",
    });
    expect(detail?.industries).toEqual(["Hardware", "Machine Learning"]);
    expect(detail?.description).toContain("novel sensing systems");
    expect(detail?.contacts).toHaveLength(1);
    expect(detail?.contacts[0]).toMatchObject({
      id: firstContact?.id,
      email: "alex@signal-works.test",
      emailStatus: "valid",
      reviewed: true,
    });
    expect(detail?.jobs).toHaveLength(1);
    expect(detail?.jobs[0].title).toBe("Founding Machine Learning Engineer");
    expect(detail?.openRolesCount).toBe(1);
    expect(detail?.freshRolesCount).toBe(1);
    expect(reviewCount.count).toBe(2);
    expect(
      detail?.audit.some((event) => event.eventType === "company.reviewed"),
    ).toBe(true);
  });

  test("reopens material edits, sequences one primary, and preserves suppressions", () => {
    const company = upsertCompany({
      name: "Northstar Systems",
      domain: "northstar-systems.test",
      location: "San Francisco, CA",
      employeeCountMin: 25,
      employeeCountMax: 80,
      industries: ["AI Infrastructure"],
    });
    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "website",
      value: "https://northstar-systems.test",
      sourceType: "test_fixture",
      sourceLabel: "Test company source",
      sourceUrl: "https://northstar-systems.test",
      confidence: 0.9,
    });
    patchCompany(company.id, {
      fitConfirmed: true,
      recruitingFit: "likely",
    });
    upsertJob({
      companyId: company.id,
      externalId: "platform-engineer",
      title: "Platform Engineer",
      sourceType: "greenhouse",
      postedAt: new Date().toISOString(),
    });
    recordReview(company.id, "approved", "Initial company review complete.");

    const founder = addContact(company.id, {
      fullName: "Jordan Lee",
      title: "Founder and CEO",
      email: "jordan@northstar-systems.test",
      emailType: "work",
      emailStatus: "valid",
      emailVerifiedAt: new Date().toISOString(),
      status: "primary",
      reviewed: true,
      rank: 1,
    });
    const operator = addContact(company.id, {
      fullName: "Casey Morgan",
      title: "Chief Operating Officer",
      email: "casey@northstar-systems.test",
      emailType: "work",
      emailStatus: "valid",
      emailVerifiedAt: new Date().toISOString(),
      status: "primary",
      reviewed: true,
      rank: 2,
    });

    const afterPrimaryChange = getCompany(company.id);
    expect(
      afterPrimaryChange?.contacts.find((contact) => contact.id === founder?.id)?.status,
    ).toBe("alternate");
    expect(
      afterPrimaryChange?.contacts.find((contact) => contact.id === operator?.id)?.status,
    ).toBe("primary");

    const editedContact = patchContact(operator!.id, {
      email: "casey.updated@northstar-systems.test",
    });
    expect(editedContact).toMatchObject({
      email: "casey.updated@northstar-systems.test",
      emailStatus: "unverified",
      emailVerifiedAt: null,
      reviewed: false,
    });

    patchCompany(company.id, { location: "Oakland, CA" });
    expect(getCompany(company.id)).toMatchObject({
      location: "Oakland, CA",
      reviewed: false,
      status: "ready_for_review",
    });

    patchContact(operator!.id, {
      status: "suppressed",
      notes: "Asked not to be contacted.",
    });
    expect(isSuppressed("CASEY.UPDATED@NORTHSTAR-SYSTEMS.TEST", "email")).toBe(true);

    addSuppression(
      "  NORTHSTAR-SYSTEMS.TEST ",
      "domain",
      "Company-level do-not-contact.",
    );
    expect(isSuppressed("northstar-systems.test", "domain")).toBe(true);
  });
});

describe("saved evidence snapshots", () => {
  test("serves contained snapshots as inert text and rejects paths outside storage", async () => {
    const company = upsertCompany({
      name: "Snapshot Test Labs",
      domain: "snapshot-test.example",
    });
    const html = "<!doctype html><script>globalThis.compromised = true</script>";
    const snapshotPath = path.join(getSnapshotsDir(), "contained.html");
    writeFileSync(snapshotPath, html, "utf8");
    const evidenceId = addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "website",
      sourceType: "test",
      sourceLabel: "Contained snapshot",
      screenshotPath: snapshotPath,
    });

    const app = createApp();
    const response = await app.request(`/api/evidence/${evidenceId}/snapshot`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(await response.text()).toBe(html);

    const outsidePath = path.join(testDataDir, "outside.html");
    writeFileSync(outsidePath, "<p>outside</p>", "utf8");
    const outsideEvidenceId = addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "website",
      sourceType: "test",
      sourceLabel: "Outside snapshot",
      screenshotPath: outsidePath,
    });
    const outsideResponse = await app.request(
      `/api/evidence/${outsideEvidenceId}/snapshot`,
    );
    expect(outsideResponse.status).toBe(403);
  });
});
