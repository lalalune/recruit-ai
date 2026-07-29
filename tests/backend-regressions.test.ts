import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SCHEMA_VERSION } from "../src/shared/version";
import { createApp } from "../src/server/app";
import {
  clearDemoData,
  createFullBackup,
  getBackupFile,
  inspectBackup,
  listBackups,
  recoverInterruptedRestore,
  restoreFullBackup,
} from "../src/server/dataManagement";
import { closeDatabase, getDatabase } from "../src/server/database";
import { importCsv, startDiscovery } from "../src/server/discovery";
import { generateDraft } from "../src/server/drafting";
import {
  getGmailStatus,
  sendApprovedDraft,
  sendGmailTestMessage,
} from "../src/server/gmail";
import {
  getDataDir,
  getDatabasePath,
  getSnapshotsDir,
} from "../src/server/paths";
import {
  acquireInstanceLock,
  releaseInstanceLock,
} from "../src/server/instanceLock";
import {
  addContact,
  addEvidence,
  addSuppression,
  claimDraftForSend,
  createOrUpdateDraft,
  getCompany,
  getContact,
  getDraft,
  getOutreachRateCounts,
  getSettings,
  isSuppressed,
  markDraftSendUnknown,
  markDraftSent,
  patchCompany,
  patchContact,
  patchDraft,
  recordReview,
  resolveConflict,
  resolveUnknownDraft,
  saveSetting,
  upsertCompany,
  upsertJob,
} from "../src/server/repository";
import { saveSecrets } from "../src/server/secrets";
import {
  findEmailWithHunter,
  verifyEmailWithHunter,
  verifyEmailWithZeroBounce,
} from "../src/server/sources/email";

const isolatedEnvironmentKeys = [
  "HUNTER_API_KEY",
  "ZEROBOUNCE_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
] as const;

let originalDataDir: string | undefined;
let originalFetch: typeof fetch;
let originalEnvironment: Partial<
  Record<(typeof isolatedEnvironmentKeys)[number], string>
>;
let temporaryDataDirs: string[] = [];

function makeDataDirectory(label = "backend-regression") {
  const directory = mkdtempSync(path.join(tmpdir(), `recruit-ai-${label}-`));
  temporaryDataDirs.push(directory);
  return directory;
}

function useDataDirectory(directory: string) {
  closeDatabase();
  process.env.RECRUITAI_DATA_DIR = directory;
  getDatabase();
}

beforeEach(() => {
  originalDataDir = process.env.RECRUITAI_DATA_DIR;
  originalFetch = globalThis.fetch;
  originalEnvironment = Object.fromEntries(
    isolatedEnvironmentKeys
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key] as string]),
  );
  for (const key of isolatedEnvironmentKeys) delete process.env[key];
  temporaryDataDirs = [];
  useDataDirectory(makeDataDirectory());
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDatabase();
  for (const key of isolatedEnvironmentKeys) {
    const original = originalEnvironment[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  if (originalDataDir === undefined) delete process.env.RECRUITAI_DATA_DIR;
  else process.env.RECRUITAI_DATA_DIR = originalDataDir;
  for (const directory of temporaryDataDirs) {
    if (directory.startsWith(path.join(tmpdir(), "recruit-ai-"))) {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 50,
      });
    }
  }
});

function apiMutation(
  app: ReturnType<typeof createApp>,
  route: string,
  body: unknown,
  method = "POST",
) {
  return app.request(`http://localhost${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-RecruitAI-Client": "1",
    },
    body: JSON.stringify(body),
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for the mocked request boundary.");
}

function createCompany(name: string, domain?: string) {
  return upsertCompany({
    name,
    domain,
    location: "San Francisco, CA",
    employeeCountMin: 8,
    employeeCountMax: 30,
    industries: ["Artificial Intelligence"],
  });
}

function requireContact(
  companyId: string,
  fullName: string,
  email?: string | null,
) {
  const contact = addContact(companyId, {
    fullName,
    title: "Founder and CEO",
    email: email ?? null,
    emailType: "work",
  });
  if (!contact) throw new Error("Test contact was not created.");
  return contact;
}

function configureGmailForTests() {
  saveSecrets({
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh-token",
  });
  const settings: Record<string, unknown> = {
    sender_name: "Shaw",
    organization_name: "RecruitAI",
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
  const company = createCompany(name, domain);
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
    recruitingFitNote: "Founder-led hiring and no internal recruiting team.",
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
  if (!draft) throw new Error("Test draft was not created.");
  patchDraft(draft.id, {
    body: `${draft.body.replace("[Your name]", "Shaw")}\n\nWould a short introduction be useful?`,
  });
  const approved = patchDraft(draft.id, { status: "approved" });
  if (!approved) throw new Error("Test draft was not approved.");
  return approved;
}

function createSendReadyDraft(input: {
  name: string;
  domain: string;
  email: string;
  emailType?: "work" | "personal" | "generic";
}) {
  configureGmailForTests();
  const companyId = createQualifiedCompany(input.name, input.domain);
  const timestamp = new Date().toISOString();
  const contact = addContact(companyId, {
    fullName: `${input.name} Founder`,
    title: "Founder and CEO",
    email: input.email,
    emailType: input.emailType || "work",
    emailStatus: "valid",
    emailVerifiedAt: timestamp,
    employmentConfirmed: true,
    observedTitle: "Founder and CEO",
    employmentObservedAt: timestamp,
    fallbackConfirmed: input.emailType === "personal",
    fallbackReason:
      input.emailType === "personal"
        ? "No current work address was found after checking the company domain."
        : null,
    status: "primary",
    reviewed: true,
  });
  if (!contact) throw new Error("Test contact was not created.");
  recordReview(companyId, "approved", "Company and decision-maker verified.");
  return {
    companyId,
    contact,
    draft: approveEditedDraft(companyId, contact.id),
  };
}

function createBasicDraft(
  companyId: string,
  key: string,
  targetStatus: "draft" | "approved" | "sending" | "sent" | "send_unknown",
) {
  const contact = requireContact(
    companyId,
    `${key} Contact`,
    `${key.toLowerCase()}@delivery-fixture.com`,
  );
  const draft = createOrUpdateDraft({
    companyId,
    contactId: contact.id,
    subject: `${key} subject`,
    body: `${key} initial body`,
  });
  if (!draft) throw new Error("Test draft was not created.");
  if (targetStatus === "draft") return draft;
  patchDraft(draft.id, { body: `${draft.body}\nOwner-reviewed edit.` });
  patchDraft(draft.id, { status: "approved" });
  if (targetStatus === "approved") return getDraft(draft.id)!;
  claimDraftForSend(draft.id);
  if (targetStatus === "sending") return getDraft(draft.id)!;
  if (targetStatus === "sent") {
    markDraftSent(draft.id, `${key}-gmail-message`);
  } else {
    markDraftSendUnknown(draft.id, "Fixture delivery ambiguity.");
  }
  return getDraft(draft.id)!;
}

describe("email provider race safety", () => {
  test("discards Hunter and ZeroBounce results when the email changes during await", async () => {
    const providers = [
      {
        name: "Hunter",
        secret: () => saveSecrets({ HUNTER_API_KEY: "hunter-fixture" }),
        verify: verifyEmailWithHunter,
        response: {
          errors: [
            {
              id: "claimed_email",
              details: "Owner requested no processing.",
            },
          ],
        },
        sourceType: "hunter",
      },
      {
        name: "ZeroBounce",
        secret: () =>
          saveSecrets({ ZEROBOUNCE_API_KEY: "zerobounce-fixture" }),
        verify: verifyEmailWithZeroBounce,
        response: { status: "do_not_mail", sub_status: "spamtrap" },
        sourceType: "zerobounce",
      },
    ] as const;

    for (const [index, provider] of providers.entries()) {
      provider.secret();
      const company = createCompany(
        `${provider.name} Race Fixture`,
        `${provider.name.toLowerCase()}-race-${index}.com`,
      );
      const oldEmail = `old-${index}@${provider.name.toLowerCase()}-race-${index}.com`;
      const newEmail = `new-${index}@${provider.name.toLowerCase()}-race-${index}.com`;
      const contact = requireContact(company.id, `${provider.name} Race`, oldEmail);
      const response = deferred<Response>();
      let fetchStarted = false;
      globalThis.fetch = (async () => {
        fetchStarted = true;
        return response.promise;
      }) as unknown as typeof fetch;

      const verification = provider.verify(contact.id);
      expect(fetchStarted).toBe(true);
      patchContact(contact.id, { email: newEmail });
      response.resolve(json(provider.response));
      let failure: unknown;
      try {
        await verification;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        "email changed while verification was running",
      );

      expect(getContact(contact.id)).toMatchObject({
        email: newEmail,
        emailStatus: "unverified",
        emailVerifiedAt: null,
      });
      expect(isSuppressed(oldEmail, "email")).toBe(false);
      expect(isSuppressed(newEmail, "email")).toBe(false);
      expect(
        (
          getDatabase()
            .query(
              `SELECT COUNT(*) AS count FROM evidence
               WHERE entity_type = 'contact' AND entity_id = ?
                 AND source_type = ?`,
            )
            .get(contact.id, provider.sourceType) as { count: number }
        ).count,
      ).toBe(0);
    }
  });

  test("rejects a cross-company Hunter finder before making a request", async () => {
    saveSecrets({ HUNTER_API_KEY: "hunter-fixture" });
    const first = createCompany("Finder Company A", "finder-company-a.com");
    const second = createCompany("Finder Company B", "finder-company-b.com");
    const contact = requireContact(second.id, "Wrong Company Contact", null);
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return json({
        data: { email: "wrong@finder-company-a.com", score: 99 },
      });
    }) as unknown as typeof fetch;

    await expect(
      findEmailWithHunter(first.id, contact.id),
    ).rejects.toThrow("does not belong to this company");
    expect(fetchCalls).toBe(0);
    expect(getContact(contact.id)?.email).toBeNull();
  });

  test("keeps a Hunter finder result unverified despite provider verification metadata", async () => {
    saveSecrets({ HUNTER_API_KEY: "hunter-fixture" });
    const company = createCompany(
      "Finder Verification Fixture",
      "finder-verification.com",
    );
    const contact = requireContact(company.id, "Finder Result", null);
    globalThis.fetch = (async () =>
      json({
        data: {
          email: "FOUND@FINDER-VERIFICATION.COM",
          score: 98,
          verification: {
            status: "valid",
            date: new Date().toISOString(),
          },
          sources: [{ uri: "https://finder-verification.com/team" }],
        },
      })) as unknown as typeof fetch;

    await expect(
      findEmailWithHunter(company.id, contact.id),
    ).resolves.toMatchObject({
      email: "found@finder-verification.com",
      emailType: "work",
      emailStatus: "unverified",
      emailVerifiedAt: null,
    });
    expect(
      (
        getDatabase()
          .query(
            `SELECT COUNT(*) AS count FROM evidence
             WHERE entity_id = ? AND source_type = 'hunter'
               AND field_name = 'email'`,
          )
          .get(contact.id) as { count: number }
      ).count,
    ).toBe(1);
  });
});

describe("Gmail send-state safety", () => {
  test("applies the canonical company-domain suppression to a personal fallback", async () => {
    const fixture = createSendReadyDraft({
      name: "Canonical Domain Safety",
      domain: "canonical-domain-safety.com",
      email: "canonical.safety.founder@gmail.com",
      emailType: "personal",
    });
    addSuppression(
      "CANONICAL-DOMAIN-SAFETY.COM",
      "domain",
      "Owner blocked the company domain.",
    );
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return json({});
    }) as unknown as typeof fetch;

    expect(getCompany(fixture.companyId)?.domain).toBe(
      "canonical-domain-safety.com",
    );
    await expect(sendApprovedDraft(fixture.draft.id)).rejects.toThrow(
      "address or domain is suppressed",
    );
    expect(fetchCalls).toBe(0);
    expect(getDraft(fixture.draft.id)?.status).toBe("approved");
  });

  test("rechecks suppression after Gmail token refresh and before sending", async () => {
    const fixture = createSendReadyDraft({
      name: "Refresh Boundary Safety",
      domain: "refresh-boundary-safety.com",
      email: "founder@refresh-boundary-safety.com",
    });
    const tokenResponse = deferred<Response>();
    let tokenStarted = false;
    let gmailSendCalls = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        tokenStarted = true;
        return tokenResponse.promise;
      }
      if (
        url ===
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
      ) {
        gmailSendCalls++;
        return json({ id: "should-not-send" });
      }
      throw new Error(`Unexpected test request: ${url}`);
    }) as unknown as typeof fetch;

    const send = sendApprovedDraft(fixture.draft.id);
    await waitFor(() => tokenStarted);
    expect(getDraft(fixture.draft.id)?.status).toBe("sending");
    addSuppression(
      fixture.contact.email!,
      "email",
      "Suppressed while OAuth refresh was in flight.",
    );
    tokenResponse.resolve(json({ access_token: "test-access-token" }));
    await expect(send).rejects.toThrow("address or domain is suppressed");

    expect(gmailSendCalls).toBe(0);
    expect(getDraft(fixture.draft.id)?.status).toBe("approved");
  });

  test("recovers an interrupted startup send as send_unknown", () => {
    const company = createCompany("Startup Recovery", "startup-recovery.com");
    const draft = createBasicDraft(company.id, "Startup", "sending");
    expect(draft.status).toBe("sending");

    closeDatabase();
    getDatabase();

    expect(getDraft(draft.id)?.status).toBe("send_unknown");
    const audit = getDatabase()
      .query(
        `SELECT payload_json FROM audit_events
         WHERE event_type = 'outreach.send_unknown' AND entity_id = ?`,
      )
      .get(company.id) as { payload_json: string };
    expect(audit.payload_json).toContain(draft.id);
    expect(audit.payload_json).toContain(
      "Application stopped while the Gmail request was in progress.",
    );
  });

  test("resolves both unknown-delivery paths with immutable audit history", () => {
    const company = createCompany("Resolution Paths", "resolution-paths.com");
    const sentUnknown = createBasicDraft(
      company.id,
      "FoundInSent",
      "send_unknown",
    );
    const notSentUnknown = createBasicDraft(
      company.id,
      "NotInSent",
      "send_unknown",
    );

    expect(
      resolveUnknownDraft(
        sentUnknown.id,
        "sent",
        "Found the message in Gmail Sent.",
      ),
    ).toMatchObject({
      status: "sent",
      outcomeNote:
        "Manual delivery resolution: Found the message in Gmail Sent.",
    });
    expect(getDraft(sentUnknown.id)?.sentAt).not.toBeNull();

    expect(
      resolveUnknownDraft(
        notSentUnknown.id,
        "not_sent",
        "Checked Gmail Sent and confirmed there is no message.",
      ),
    ).toMatchObject({
      status: "approved",
      sentAt: null,
      outcomeNote: null,
    });

    const events = getDatabase()
      .query(
        `SELECT event_type FROM audit_events
         WHERE entity_id = ? AND event_type LIKE 'outreach.send_unknown_resolved_%'
         ORDER BY event_type`,
      )
      .all(company.id) as Array<{ event_type: string }>;
    expect(events.map((event) => event.event_type)).toEqual([
      "outreach.send_unknown_resolved_not_sent",
      "outreach.send_unknown_resolved_sent",
    ]);
  });

  test("invalidates the Gmail self-test when sender identity changes", async () => {
    configureGmailForTests();
    expect(getGmailStatus()).toMatchObject({
      sendingEnabled: true,
      testPassed: true,
    });

    const response = await apiMutation(
      createApp(),
      "/api/settings",
      { sender_name: "A Different Sender" },
      "PATCH",
    );

    expect(response.status).toBe(200);
    expect(getSettings()).toMatchObject({
      sender_name: "A Different Sender",
      gmail_sending_enabled: false,
      gmail_test_passed_at: null,
    });
    expect(getGmailStatus()).toMatchObject({
      sendingEnabled: false,
      testPassed: false,
    });
  });
});

describe("backup, restore, and startup persistence", () => {
  test("refuses an encoded backup that cannot fit under the restore limit", () => {
    createCompany("Oversized Backup Guard", "oversized-backup-guard.com");

    expect(() => createFullBackup(256)).toThrow(
      "Cannot create a restorable backup",
    );
    expect(listBackups()).toEqual([]);
    expect(readdirSync(path.join(getDataDir(), "backups"))).toEqual([]);
  });

  test("rewrites restored snapshot references for a different data directory", () => {
    const sourceDirectory = process.env.RECRUITAI_DATA_DIR!;
    const company = createCompany("Snapshot Restore", "snapshot-restore.com");
    const snapshotContent = "source snapshot";
    const snapshotName = `${createHash("sha256").update(snapshotContent).digest("hex")}.html`;
    const sourceSnapshotPath = path.join(getSnapshotsDir(), snapshotName);
    writeFileSync(sourceSnapshotPath, snapshotContent, "utf8");
    const evidenceId = addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "website",
      value: "https://snapshot-restore.com",
      sourceType: "company_website",
      sourceLabel: "Company website",
      screenshotPath: sourceSnapshotPath,
    });
    const backup = createFullBackup();
    const backupDirectory = path.join(getDataDir(), "backups");
    expect(
      existsSync(
        path.join(
          backupDirectory,
          backup.fileName.replace(/\.json$/, ".meta"),
        ),
      ),
    ).toBe(true);
    expect(
      readdirSync(backupDirectory).some((entry) => entry.endsWith(".tmp")),
    ).toBe(false);
    const backupText = readFileSync(
      getBackupFile(backup.fileName).filePath,
      "utf8",
    );

    const destinationDirectory = makeDataDirectory("restore-destination");
    useDataDirectory(destinationDirectory);
    restoreFullBackup(backupText);

    const restored = getDatabase()
      .query("SELECT screenshot_path FROM evidence WHERE id = ?")
      .get(evidenceId) as { screenshot_path: string };
    const expectedPath = path.join(
      destinationDirectory,
      "snapshots",
      snapshotName,
    );
    expect(sourceDirectory).not.toBe(destinationDirectory);
    expect(restored.screenshot_path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf8")).toBe("source snapshot");
  });

  test("restores replayable drafts fail-closed and disables the Gmail test", () => {
    const company = createCompany("Restore Replay", "restore-replay.com");
    const draft = createBasicDraft(company.id, "Draft", "draft");
    const approved = createBasicDraft(company.id, "Approved", "approved");
    const sending = createBasicDraft(company.id, "Sending", "sending");
    const sent = createBasicDraft(company.id, "Sent", "sent");
    saveSetting("gmail_sending_enabled", true);
    saveSetting("gmail_test_passed_at", new Date().toISOString());
    const backup = createFullBackup();
    const backupText = readFileSync(
      getBackupFile(backup.fileName).filePath,
      "utf8",
    );

    useDataDirectory(makeDataDirectory("replay-destination"));
    restoreFullBackup(backupText);

    for (const replayable of [draft, approved, sending]) {
      expect(getDraft(replayable.id)?.status).toBe("send_unknown");
    }
    expect(getDraft(sent.id)?.status).toBe("sent");
    expect(getSettings()).toMatchObject({
      gmail_sending_enabled: false,
      gmail_test_passed_at: null,
    });
    expect(
      (
        getDatabase()
          .query(
            `SELECT COUNT(*) AS count FROM audit_events
             WHERE event_type = 'outreach.restore_reconciliation_required'
               AND entity_id = ?`,
          )
          .get(company.id) as { count: number }
      ).count,
    ).toBe(2);
    expect(
      (
        getDatabase()
          .query(
            `SELECT COUNT(*) AS count FROM audit_events
             WHERE event_type = 'outreach.send_unknown' AND entity_id = ?
               AND payload_json LIKE ?`,
          )
          .get(company.id, `%${sending.id}%`) as { count: number }
      ).count,
    ).toBe(1);
  });

  test("records the current schema migration and rejects a newer version", () => {
    const rows = getDatabase()
      .query(
        "SELECT version, applied_at FROM schema_migrations ORDER BY version",
      )
      .all() as Array<{ version: number; applied_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(SCHEMA_VERSION);
    expect(Number.isFinite(Date.parse(rows[0].applied_at))).toBe(true);

    getDatabase()
      .query("UPDATE schema_migrations SET version = ? WHERE version = ?")
      .run(SCHEMA_VERSION + 1, SCHEMA_VERSION);
    closeDatabase();
    expect(() => getDatabase()).toThrow(
      `schema version ${SCHEMA_VERSION + 1}`,
    );
  });
});

describe("record integrity and API validation", () => {
  test("does not clear a real company whose URL merely contains .example", () => {
    const realCompany = upsertCompany({
      name: "Adversarial Example URL",
      domain: "adversarial-example-url.com",
      websiteUrl:
        "https://adversarial-example-url.com/redirect?next=https://demo.example",
    });
    const demoCompany = upsertCompany({
      name: "Actual Demo Fixture",
      domain: "actual-demo.example",
    });

    expect(clearDemoData().removedCompanies).toBe(1);
    expect(getCompany(realCompany.id)?.name).toBe("Adversarial Example URL");
    expect(getCompany(demoCompany.id)).toBeNull();
  });

  test("reopens review when a provider upsert adds material company data", () => {
    const seed = upsertCompany({ name: "Provider Refresh Labs" });
    patchCompany(seed.id, { status: "approved", reviewed: true });

    const refreshed = upsertCompany({
      name: "Provider Refresh Labs",
      domain: "provider-refresh-labs.com",
      location: "Oakland, CA",
      employeeCountMin: 12,
      employeeCountMax: 45,
      industries: ["Robotics"],
      stage: "Seed",
    });

    expect(refreshed).toEqual({ id: seed.id, inserted: false });
    expect(getCompany(seed.id)).toMatchObject({
      domain: "provider-refresh-labs.com",
      location: "Oakland, CA",
      employeeCountMin: 12,
      employeeCountMax: 45,
      industries: ["Robotics"],
      stage: "Seed",
      status: "ready_for_review",
      reviewed: false,
    });
    expect(
      getCompany(seed.id)?.audit.some(
        (event) => event.eventType === "company.material_refresh",
      ),
    ).toBe(true);
  });

  test("returns 400 for negative and non-numeric company pagination", async () => {
    const app = createApp();
    const negative = await app.request(
      "http://localhost/api/companies?limit=-1",
    );
    const notANumber = await app.request(
      "http://localhost/api/companies?offset=NaN",
    );

    expect(negative.status).toBe(400);
    expect(notANumber.status).toBe(400);
  });

  test("requires confirmed manual evidence and an existing entity", async () => {
    const app = createApp();
    const company = createCompany(
      "Manual Evidence Integrity",
      "manual-evidence-integrity.com",
    );
    const unconfirmed = await apiMutation(app, "/api/evidence/manual", {
      entityType: "company",
      entityId: company.id,
      fieldName: "location",
      value: "San Francisco, CA",
      confirmed: false,
    });
    expect(unconfirmed.status).toBe(400);

    expect(() =>
      addEvidence({
        entityType: "company",
        entityId: crypto.randomUUID(),
        fieldName: "location",
        value: "San Francisco, CA",
        sourceType: "manual",
        sourceLabel: "Manually confirmed",
      }),
    ).toThrow("selected evidence entity no longer exists");

    const confirmed = await apiMutation(app, "/api/evidence/manual", {
      entityType: "company",
      entityId: company.id,
      fieldName: "location",
      value: "San Francisco, CA",
      confirmed: true,
    });
    expect(confirmed.status).toBe(201);
    expect(
      getCompany(company.id)?.evidence.some(
        (evidence) =>
          evidence.sourceType === "manual" &&
          evidence.sourceLabel === "Manually confirmed" &&
          evidence.confidence === 0.9,
      ),
    ).toBe(true);
  });
});

describe("provider merge and canonical record invariants", () => {
  test("preserves curated contacts and same-email verification across source refreshes", () => {
    const company = createCompany(
      "Curated Contact Labs",
      "curated-contact-labs.com",
    );
    const verifiedAt = new Date().toISOString();
    const primary = addContact(company.id, {
      fullName: "Avery Founder",
      title: "Founder and CEO",
      email: "avery@curated-contact-labs.com",
      emailType: "work",
      emailStatus: "valid",
      emailVerifiedAt: verifiedAt,
      rank: 1,
      status: "primary",
      reviewed: true,
    })!;

    const sourceRefresh = addContact(company.id, {
      fullName: "Avery",
      title: "Published company contact",
      email: "AVERY@curated-contact-labs.com",
      emailType: "generic",
      emailStatus: "unverified",
      emailVerifiedAt: null,
      rank: 20,
      status: "alternate",
    });
    expect(sourceRefresh).toMatchObject({
      id: primary.id,
      fullName: "Avery Founder",
      title: "Founder and CEO",
      email: "avery@curated-contact-labs.com",
      emailType: "work",
      emailStatus: "valid",
      emailVerifiedAt: verifiedAt,
      rank: 1,
      status: "primary",
      reviewed: true,
    });

    patchContact(primary.id, {
      email: "AVERY@curated-contact-labs.com",
      notes: "Owner saved an unrelated note.",
    });
    expect(getContact(primary.id)).toMatchObject({
      email: "avery@curated-contact-labs.com",
      emailStatus: "valid",
      emailVerifiedAt: verifiedAt,
      status: "primary",
      reviewed: true,
    });

    const providerCandidate = addContact(company.id, {
      fullName: "Morgan Operator",
      title: "COO",
      email: "morgan@curated-contact-labs.com",
      emailType: "work",
      emailStatus: "unverified",
      status: "primary",
    })!;
    expect(providerCandidate.status).toBe("alternate");
    expect(getContact(primary.id)?.status).toBe("primary");
  });

  test("reopens an exact identity collision after it recurs", () => {
    const first = createCompany(
      "Recurring Identity Labs",
      "recurring-identity-one.com",
    );
    const second = createCompany(
      "Recurring Identity Labs",
      "recurring-identity-two.com",
    );
    const originalConflictIds = new Set(
      getCompany(first.id)?.conflicts
        .filter((item) => item.status === "open" && item.fieldName === "identity")
        .map((item) => item.id),
    );
    expect(originalConflictIds.size).toBe(1);

    patchCompany(second.id, { name: "Distinct Identity Labs" });
    expect(getCompany(first.id)?.conflictCount).toBe(0);
    expect(getCompany(second.id)?.conflictCount).toBe(0);

    patchCompany(second.id, { name: "Recurring Identity Labs" });
    const recurring = getCompany(first.id)?.conflicts.filter(
      (item) => item.status === "open" && item.fieldName === "identity",
    );
    expect(recurring).toHaveLength(1);
    expect(originalConflictIds.has(recurring![0].id)).toBe(false);
    expect(getCompany(first.id)?.conflictCount).toBe(1);
    expect(getCompany(second.id)?.conflictCount).toBe(1);
  });

  test("validates and canonicalizes every company upsert at the repository boundary", () => {
    expect(() =>
      upsertCompany({
        name: "X".repeat(501),
      }),
    ).toThrow();
    expect(() =>
      upsertCompany({
        name: "Invalid Range Labs",
        employeeCountMin: 50,
        employeeCountMax: 5,
      }),
    ).toThrow("Minimum employees cannot exceed maximum employees");
    expect(() =>
      upsertCompany({
        name: "Unexpected Field Labs",
        fitConfirmed: true,
      } as unknown as Parameters<typeof upsertCompany>[0]),
    ).toThrow();
    expect(
      (
        getDatabase()
          .query("SELECT COUNT(*) AS count FROM companies")
          .get() as { count: number }
      ).count,
    ).toBe(0);

    const canonical = upsertCompany({
      name: "  Canonical Provider Labs  ",
      websiteUrl: "  https://canonical-provider-labs.com/about  ",
      location: "  Oakland, CA  ",
      industries: ["  Artificial Intelligence  "],
    });
    expect(getCompany(canonical.id)).toMatchObject({
      name: "Canonical Provider Labs",
      domain: "canonical-provider-labs.com",
      websiteUrl: "https://canonical-provider-labs.com/about",
      location: "Oakland, CA",
      industries: ["Artificial Intelligence"],
    });
  });

  test("reuses only a unique compatible historical company alias", () => {
    const unique = upsertCompany({
      name: "Old Alias Labs",
      domain: "unique-alias-labs.com",
      location: "San Francisco, CA",
    });
    upsertCompany({
      name: "Modern Alias Laboratory",
      domain: "unique-alias-labs.com",
    });

    const reused = upsertCompany({ name: "Old Alias Labs" });
    expect(reused).toEqual({ id: unique.id, inserted: false });
    expect(getCompany(unique.id)?.name).toBe("Modern Alias Laboratory");
    expect(
      (
        getDatabase()
          .query("SELECT COUNT(*) AS count FROM companies")
          .get() as { count: number }
      ).count,
    ).toBe(1);

    const first = upsertCompany({
      name: "Shared Historical Alias",
      domain: "shared-alias-one.com",
      location: "Oakland, CA",
    });
    upsertCompany({
      name: "Shared Historical Alias One",
      domain: "shared-alias-one.com",
    });
    const second = upsertCompany({
      name: "Shared Historical Alias",
      domain: "shared-alias-two.com",
      location: "Berkeley, CA",
    });
    upsertCompany({
      name: "Shared Historical Alias Two",
      domain: "shared-alias-two.com",
    });

    const ambiguous = upsertCompany({ name: "Shared Historical Alias" });
    expect(ambiguous.inserted).toBe(true);
    expect(ambiguous.id).not.toBe(first.id);
    expect(ambiguous.id).not.toBe(second.id);
  });

  test("retains manual rename aliases atomically and reuses the old name", () => {
    const company = createCompany(
      "Original Manual Identity",
      "manual-rename-identity.com",
    );
    const database = getDatabase();
    database.exec(
      `CREATE TRIGGER fail_manual_alias_insert
       BEFORE INSERT ON company_aliases
       WHEN NEW.alias = 'Renamed Manual Identity'
       BEGIN
         SELECT RAISE(ABORT, 'forced alias failure');
       END`,
    );
    expect(() =>
      patchCompany(company.id, { name: "Renamed Manual Identity" }),
    ).toThrow("forced alias failure");
    expect(getCompany(company.id)?.name).toBe("Original Manual Identity");
    expect(
      (
        database
          .query(
            "SELECT COUNT(*) AS count FROM company_aliases WHERE company_id = ?",
          )
          .get(company.id) as { count: number }
      ).count,
    ).toBe(0);
    database.exec("DROP TRIGGER fail_manual_alias_insert");

    patchCompany(company.id, { name: "Renamed Manual Identity" });
    expect(
      (
        database
          .query(
            `SELECT alias FROM company_aliases
             WHERE company_id = ? ORDER BY alias`,
          )
          .all(company.id) as Array<{ alias: string }>
      ).map((row) => row.alias),
    ).toEqual(["Original Manual Identity", "Renamed Manual Identity"]);

    const rediscovered = upsertCompany({ name: "Original Manual Identity" });
    expect(rediscovered).toEqual({ id: company.id, inserted: false });
    expect(getCompany(company.id)?.name).toBe("Renamed Manual Identity");
    expect(
      (
        database
          .query("SELECT COUNT(*) AS count FROM companies")
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });

  test("preserves reviewed company facts and records provider disagreements", () => {
    const company = upsertCompany({
      name: "Curated Company Facts",
      domain: "curated-company-facts.com",
      description: "Owner-confirmed company description.",
      location: "San Francisco, CA",
      employeeCountMin: 120,
      employeeCountMax: 150,
      industries: ["Artificial Intelligence"],
      stage: "Seed",
      priority: "high",
    });
    patchCompany(company.id, { status: "approved", reviewed: true });

    const refreshed = upsertCompany({
      name: "Curated Company Facts",
      domain: "curated-company-facts.com",
      description:
        "A much longer provider description that must not replace owner-confirmed copy.",
      location: "San Jose, CA",
      employeeCountMin: 5,
      employeeCountMax: 5,
      industries: ["Generic Technology"],
      stage: "Series A",
      priority: "low",
    });

    expect(refreshed).toEqual({ id: company.id, inserted: false });
    const preserved = getCompany(company.id)!;
    expect(preserved).toMatchObject({
      description: "Owner-confirmed company description.",
      location: "San Francisco, CA",
      employeeCountMin: 120,
      employeeCountMax: 150,
      industries: ["Artificial Intelligence"],
      stage: "Seed",
      priority: "high",
      status: "ready_for_review",
      reviewed: false,
    });
    expect(
      preserved.conflicts.map((conflict) => ({
        fieldName: conflict.fieldName,
        currentValue: conflict.currentValue,
        candidateValue: conflict.candidateValue,
        status: conflict.status,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          fieldName: "location",
          currentValue: "San Francisco, CA",
          candidateValue: "San Jose, CA",
          status: "open",
        },
        {
          fieldName: "employee_count",
          currentValue: "120–150",
          candidateValue: "5–5",
          status: "open",
        },
        {
          fieldName: "stage",
          currentValue: "Seed",
          candidateValue: "Series A",
          status: "open",
        },
      ]),
    );
  });

  test("preserves unknown employee bounds and prefers structured conflict evidence", () => {
    const cases: Array<{
      name: string;
      value: string;
      payload?: unknown;
      expectedMinimum: number | null;
      expectedMaximum: number | null;
    }> = [
      {
        name: "Partial Employee Minimum",
        value: "5–?",
        expectedMinimum: 5,
        expectedMaximum: null,
      },
      {
        name: "Partial Employee Maximum",
        value: "?–100",
        expectedMinimum: null,
        expectedMaximum: 100,
      },
      {
        name: "Structured Employee Range",
        value: "999–999",
        payload: {
          employeeCountMin: 7,
          employeeCountMax: null,
        },
        expectedMinimum: 7,
        expectedMaximum: null,
      },
    ];

    for (const [index, candidate] of cases.entries()) {
      const company = createCompany(
        candidate.name,
        `partial-employee-${index}.com`,
      );
      addEvidence({
        entityType: "company",
        entityId: company.id,
        fieldName: "employee_count",
        value: candidate.value,
        sourceType: "test",
        sourceLabel: "Conflicting employee range",
        payload: candidate.payload,
      });
      const conflictId = getCompany(company.id)?.conflicts.find(
        (conflict) => conflict.fieldName === "employee_count",
      )?.id;
      expect(conflictId).toBeString();

      resolveConflict(
        conflictId!,
        "use_candidate",
        "Use the more recent employee range.",
      );
      expect(getCompany(company.id)).toMatchObject({
        employeeCountMin: candidate.expectedMinimum,
        employeeCountMax: candidate.expectedMaximum,
      });
    }
  });
});

describe("concurrency, review, and suppression invariants", () => {
  test("counts unknown Gmail attempts pessimistically and blocks later sends", () => {
    configureGmailForTests();
    const company = createCompany("Unknown Attempt Labs", "unknown-attempt.com");
    createBasicDraft(company.id, "UnknownAttempt", "send_unknown");

    expect(getOutreachRateCounts("UTC")).toMatchObject({
      sentLastHour: 1,
      sentToday: 1,
      unresolvedUnknown: 1,
    });
    expect(getGmailStatus().missingRequirements).toContain(
      "unresolved Gmail delivery",
    );
    expect(getGmailStatus().sendReady).toBe(false);
  });

  test("invalidates approved messages after material record changes", () => {
    const company = createCompany("Revision Gate Labs", "revision-gate.com");
    const draft = createBasicDraft(company.id, "Revision", "approved");

    patchCompany(company.id, { location: "Oakland, CA" });
    expect(getDraft(draft.id)?.status).toBe("draft");

    patchDraft(draft.id, { status: "approved" });
    const contactId = getDraft(draft.id)!.contactId;
    patchContact(contactId, { title: "Chief Executive Officer" });
    expect(getDraft(draft.id)?.status).toBe("draft");
    expect(
      getCompany(company.id)?.audit.some(
        (event) => event.eventType === "outreach.approval_invalidated",
      ),
    ).toBe(true);
  });

  test("canonicalizes URL-shaped domain suppressions", () => {
    addSuppression(
      "HTTPS://WWW.Example-Suppression.com/careers",
      "domain",
      "Owner exclusion",
    );
    expect(isSuppressed("example-suppression.com", "domain")).toBe(true);
    expect(
      isSuppressed("https://www.example-suppression.com/about", "domain"),
    ).toBe(true);
    expect(() => addSuppression("localhost", "domain", "invalid")).toThrow(
      "valid public domain",
    );
  });

  test("rolls back primary demotion if the target contact update fails", () => {
    const company = createCompany("Primary Atomicity Labs", "primary-atomicity.com");
    const first = addContact(company.id, {
      fullName: "Primary One",
      email: "one@primary-atomicity.com",
      status: "primary",
    })!;
    const second = addContact(company.id, {
      fullName: "Primary Two",
      email: "two@primary-atomicity.com",
      status: "alternate",
    })!;

    expect(() =>
      patchContact(second.id, {
        status: "primary",
        email: "one@primary-atomicity.com",
      }),
    ).toThrow();
    expect(getContact(first.id)?.status).toBe("primary");
    expect(getContact(second.id)?.status).toBe("alternate");
  });

  test("rejects invalid candidate values during conflict resolution", () => {
    const company = createCompany("Conflict Validation", "conflict-validation.com");
    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "domain",
      value: "not a public domain",
      sourceType: "manual",
      sourceLabel: "Conflicting manual evidence",
    });
    const conflictId = getCompany(company.id)?.conflicts.find(
      (item) => item.fieldName === "domain",
    )?.id;
    expect(conflictId).toBeString();
    expect(() =>
      resolveConflict(
        conflictId!,
        "use_candidate",
        "Test invalid candidate rejection.",
      ),
    ).toThrow("candidate domain value is invalid");
    expect(getCompany(company.id)?.domain).toBe("conflict-validation.com");
  });

  test("blocks restore while a Gmail send is queued or in flight", async () => {
    const ready = createSendReadyDraft({
      name: "Restore Race Labs",
      domain: "restore-race.com",
      email: "founder@restore-race.com",
    });
    const backup = createFullBackup();
    const backupText = readFileSync(
      getBackupFile(backup.fileName).filePath,
      "utf8",
    );
    const tokenResponse = deferred<Response>();
    let tokenRequested = false;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        tokenRequested = true;
        return tokenResponse.promise;
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        return json({ id: "restore-race-message" });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const sending = sendApprovedDraft(ready.draft.id);
    await waitFor(() => tokenRequested);
    expect(() => restoreFullBackup(backupText)).toThrow(
      "active network operation",
    );
    tokenResponse.resolve(json({ access_token: "restore-race-token" }));
    await expect(sending).resolves.toMatchObject({ status: "sent" });
  });

  test("blocks backup and restore for the full lifetime of a background discovery run", async () => {
    const backup = createFullBackup();
    const backupText = readFileSync(
      getBackupFile(backup.fileName).filePath,
      "utf8",
    );
    const providerResponse = deferred<Response>();
    let providerRequested = false;
    globalThis.fetch = (async () => {
      providerRequested = true;
      return providerResponse.promise;
    }) as unknown as typeof fetch;

    const runId = startDiscovery({
      source: "datasf",
      limit: 1,
      technologyOnly: true,
    });
    await waitFor(() => providerRequested);
    const backupCount = listBackups().length;
    expect(() => createFullBackup()).toThrow("active network operation");
    expect(listBackups()).toHaveLength(backupCount);
    expect(() => restoreFullBackup(backupText)).toThrow(
      "active network operation",
    );

    providerResponse.resolve(json([]));
    await waitFor(() => {
      const row = getDatabase()
        .query("SELECT status FROM source_runs WHERE id = ?")
        .get(runId) as { status: string } | null;
      return row?.status === "completed";
    });
    await Bun.sleep(0);
    expect(() => createFullBackup()).not.toThrow();
    expect(() => restoreFullBackup(backupText)).not.toThrow();
  });

  test("does not certify a sender identity changed during the Gmail test", async () => {
    configureGmailForTests();
    saveSetting("gmail_test_passed_at", null);
    const tokenResponse = deferred<Response>();
    let tokenRequested = false;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        tokenRequested = true;
        return tokenResponse.promise;
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        return json({ id: "identity-race-test" });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const testMessage = sendGmailTestMessage();
    await waitFor(() => tokenRequested);
    saveSetting("sender_name", "Changed During Test");
    tokenResponse.resolve(json({ access_token: "identity-race-token" }));
    await expect(testMessage).rejects.toThrow(
      "changed during the test",
    );
    expect(getSettings().gmail_test_passed_at).toBeNull();
  });
});

describe("bounded imports and evidence", () => {
  test("skips row-scoped CSV invariant violations without aborting valid rows", () => {
    const industries = Array.from({ length: 101 }, (_, index) => `Tag${index}`).join("|");
    const csv = [
      "company_name,employee_count_min,employee_count_max,industries,full_name,email,notes",
      "Bad Range,100,10,AI,,,",
      `${"X".repeat(501)},3,10,AI,,,`,
      `Too Many Industries,3,10,\"${industries}\",,,`,
      "Contact Survives,3,10,AI,Owner,not-an-email,",
    ].join("\n");
    const result = importCsv(csv, "Bounded CSV");

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(3);
    expect(result.contacts).toBe(0);
    expect(result.parseWarnings.join(" ")).toContain("Row 2");
    expect(result.parseWarnings.join(" ")).toContain("Contact skipped");
    expect(
      (
        getDatabase()
          .query("SELECT COUNT(*) AS count FROM companies")
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });

  test("bounds evidence fields and summarizes oversized payloads", () => {
    const company = createCompany("Evidence Bounds", "evidence-bounds.com");
    const evidenceId = addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "oversized_payload",
      value: "v".repeat(10_000),
      sourceType: "fixture",
      sourceLabel: "Oversized fixture",
      excerpt: "e".repeat(10_000),
      confidence: 42,
      payload: { content: "p".repeat(200_000) },
    });
    const row = getDatabase()
      .query(
        `SELECT value, excerpt, confidence, payload_json
         FROM evidence WHERE id = ?`,
      )
      .get(evidenceId) as {
      value: string;
      excerpt: string;
      confidence: number;
      payload_json: string;
    };
    expect(row.value.length).toBe(5_000);
    expect(row.excerpt.length).toBe(5_000);
    expect(row.confidence).toBe(1);
    expect(JSON.parse(row.payload_json)).toMatchObject({
      truncated: true,
      originalBytes: expect.any(Number),
      sha256: expect.any(String),
    });
    expect(row.payload_json.length).toBeLessThan(1_000);
  });
});

describe("schema and restore crash recovery", () => {
  test("enforces one process per local data directory and recovers stale locks", () => {
    const lockPath = acquireInstanceLock();
    try {
      const moduleUrl = pathToFileURL(
        path.resolve("src/server/instanceLock.ts"),
      ).href;
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          `import { acquireInstanceLock } from ${JSON.stringify(moduleUrl)}; acquireInstanceLock();`,
        ],
        env: {
          ...process.env,
          RECRUITAI_DATA_DIR: process.env.RECRUITAI_DATA_DIR!,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).not.toBe(0);
      expect(child.stderr.toString()).toContain("already using this local data");
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      releaseInstanceLock();
    }

    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        token: "stale-lock",
        createdAt: new Date(0).toISOString(),
      }),
    );
    expect(acquireInstanceLock()).toBe(lockPath);
    releaseInstanceLock();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("rejects a future schema before mutating sqlite_master", () => {
    const directory = makeDataDirectory("future-no-mutation");
    closeDatabase();
    process.env.RECRUITAI_DATA_DIR = directory;
    const filePath = path.join(directory, "recruit-ai.sqlite");
    const raw = new Database(filePath, { create: true });
    raw.exec(
      `CREATE TABLE schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL
       );
       CREATE TABLE future_marker (id TEXT PRIMARY KEY);
       INSERT INTO schema_migrations VALUES (999, 'future');`,
    );
    const before = raw
      .query(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all();
    raw.close();

    expect(() => getDatabase()).toThrow("supports up to");
    const verify = new Database(filePath, { readwrite: true, create: false });
    const after = verify
      .query(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all();
    expect(after).toEqual(before);
    expect(
      verify
        .query(
          "SELECT 1 AS found FROM sqlite_master WHERE name = 'companies'",
        )
        .get(),
    ).toBeNull();
    verify.close();
  });

  test("migrates a legitimate version-zero backup before current validation", () => {
    const company = createCompany("Legacy Restore", "legacy-restore.com");
    requireContact(company.id, "Legacy Founder", "founder@legacy-restore.com");
    const database = getDatabase();
    database.exec(
      `ALTER TABLE contacts DROP COLUMN fallback_reason;
       DELETE FROM schema_migrations;`,
    );
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    closeDatabase();
    const backupText = JSON.stringify({
      format: "recruitai-local-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      appVersion: "0.0.1",
      databaseBase64: readFileSync(getDatabasePath()).toString("base64"),
      snapshots: [],
    });
    expect(inspectBackup(backupText)).toMatchObject({
      format: "recruitai-local-backup",
      snapshotCount: 0,
    });

    useDataDirectory(makeDataDirectory("legacy-restore-target"));
    restoreFullBackup(backupText);
    const columns = getDatabase()
      .query("PRAGMA table_info('contacts')")
      .all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "fallback_reason")).toBe(true);
    expect(getCompany(company.id)?.name).toBe("Legacy Restore");
  });

  test("rolls back an interrupted mixed-generation restore on startup", () => {
    const company = createCompany("Journal Recovery", "journal-recovery.com");
    const dataDirectory = getDataDir();
    const databasePath = getDatabasePath();
    const snapshotsPath = getSnapshotsDir();
    const restoreId = crypto.randomUUID();
    const rollbackPath = path.join(
      dataDirectory,
      `.rollback-${restoreId}.sqlite`,
    );
    const rollbackSnapshotsPath = path.join(
      dataDirectory,
      `.rollback-snapshots-${restoreId}`,
    );
    closeDatabase();
    renameSync(databasePath, rollbackPath);
    writeFileSync(databasePath, "incomplete replacement");
    renameSync(snapshotsPath, rollbackSnapshotsPath);
    mkdirSync(snapshotsPath, { recursive: false });
    writeFileSync(
      path.join(dataDirectory, ".restore-journal.json"),
      JSON.stringify({
        version: 1,
        restoreId,
        phase: "new_snapshots_installed",
        createdAt: new Date().toISOString(),
        snapshotNames: [],
      }),
    );

    expect(recoverInterruptedRestore()).toEqual({
      recovered: true,
      phase: "rolled_back",
    });
    expect(getCompany(company.id)?.name).toBe("Journal Recovery");
    expect(
      existsSync(path.join(dataDirectory, ".restore-journal.json")),
    ).toBe(false);
  });

  test("validates committed foreign keys and rolls back when they are broken", () => {
    const company = createCompany(
      "Committed Rollback",
      "committed-rollback.com",
    );
    requireContact(
      company.id,
      "Committed Founder",
      "founder@committed-rollback.com",
    );
    const dataDirectory = getDataDir();
    const databasePath = getDatabasePath();
    const snapshotsPath = getSnapshotsDir();
    const restoreId = crypto.randomUUID();
    const rollbackPath = path.join(
      dataDirectory,
      `.rollback-${restoreId}.sqlite`,
    );
    const rollbackSnapshotsPath = path.join(
      dataDirectory,
      `.rollback-snapshots-${restoreId}`,
    );
    closeDatabase();
    renameSync(databasePath, rollbackPath);
    writeFileSync(databasePath, readFileSync(rollbackPath));
    const brokenDatabase = new Database(databasePath, {
      readwrite: true,
      create: false,
    });
    brokenDatabase.exec("PRAGMA foreign_keys = OFF");
    brokenDatabase
      .query("DELETE FROM companies WHERE id = ?")
      .run(company.id);
    brokenDatabase.close();
    renameSync(snapshotsPath, rollbackSnapshotsPath);
    mkdirSync(snapshotsPath, { recursive: false });
    writeFileSync(
      path.join(dataDirectory, ".restore-journal.json"),
      JSON.stringify({
        version: 1,
        restoreId,
        phase: "committed",
        createdAt: new Date().toISOString(),
        snapshotNames: [],
      }),
    );

    expect(recoverInterruptedRestore()).toEqual({
      recovered: true,
      phase: "rolled_back",
    });
    expect(getCompany(company.id)?.name).toBe("Committed Rollback");
    expect(existsSync(rollbackPath)).toBe(false);
    expect(existsSync(rollbackSnapshotsPath)).toBe(false);
    expect(
      existsSync(path.join(dataDirectory, ".restore-journal.json")),
    ).toBe(false);
  });

  test("preserves a corrupt committed generation when no rollback remains", () => {
    const dataDirectory = getDataDir();
    const databasePath = getDatabasePath();
    const restoreId = crypto.randomUUID();
    closeDatabase();
    writeFileSync(databasePath, "corrupt committed database");
    const journalPath = path.join(dataDirectory, ".restore-journal.json");
    writeFileSync(
      journalPath,
      JSON.stringify({
        version: 1,
        restoreId,
        phase: "committed",
        createdAt: new Date().toISOString(),
        snapshotNames: [],
      }),
    );

    expect(() => recoverInterruptedRestore()).toThrow(
      "no complete rollback generation remains",
    );
    expect(readFileSync(databasePath, "utf8")).toBe(
      "corrupt committed database",
    );
    expect(existsSync(journalPath)).toBe(true);
  });
});
