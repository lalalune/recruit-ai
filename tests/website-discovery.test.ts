import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, getDatabase } from "../src/server/database";
import { importCsv, startDiscovery } from "../src/server/discovery";
import {
  getCompany,
  listSourceRuns,
  upsertCompany,
  upsertJob,
} from "../src/server/repository";
import { saveSecrets } from "../src/server/secrets";
import {
  assessHiringSurfaceHtml,
  parseStructuredJobs,
  reconcileCompanyWebsiteJobs,
  structuredJobExternalId,
} from "../src/server/sources/website";

let testDataDir = "";
let originalDataDir: string | undefined;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalDataDir = process.env.RECRUITAI_DATA_DIR;
  originalFetch = globalThis.fetch;
  testDataDir = mkdtempSync(path.join(tmpdir(), "recruit-ai-website-test-"));
  closeDatabase();
  process.env.RECRUITAI_DATA_DIR = testDataDir;
  getDatabase();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDatabase();
  if (originalDataDir === undefined) {
    delete process.env.RECRUITAI_DATA_DIR;
  } else {
    process.env.RECRUITAI_DATA_DIR = originalDataDir;
  }
  if (testDataDir.startsWith(path.join(tmpdir(), "recruit-ai-website-test-"))) {
    rmSync(testDataDir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 50,
    });
  }
});

async function waitForRun(runId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = listSourceRuns(100).find((item) => item.id === runId);
    if (run && ["completed", "failed"].includes(run.status)) return run;
    await Bun.sleep(5);
  }
  throw new Error(`Source run ${runId} did not finish.`);
}

describe("company-website structured jobs", () => {
  test("extracts PropertyValue identifiers and uses a stable fallback", () => {
    const html = `
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "JobPosting",
              "title": "Robotics Engineer",
              "identifier": {
                "@type": "PropertyValue",
                "name": "Acme job number",
                "value": "robotics-123"
              }
            },
            {
              "@type": "JobPosting",
              "title": "ML Engineer",
              "identifier": [{
                "@type": "PropertyValue",
                "value": 456
              }]
            },
            {
              "@type": "JobPosting",
              "title": "Research Scientist",
              "jobLocation": {
                "address": {
                  "addressRegion": "CA",
                  "addressLocality": "San Francisco"
                }
              }
            }
          ]
        }
      </script>
    `;
    const jobs = parseStructuredJobs(html);
    expect(jobs).toHaveLength(3);
    expect(structuredJobExternalId(jobs[0], "https://acme.com/careers")).toBe(
      "robotics-123",
    );
    expect(structuredJobExternalId(jobs[1], "https://acme.com/careers")).toBe(
      "456",
    );

    const fallback = structuredJobExternalId(
      jobs[2],
      "https://acme.com/careers",
    );
    expect(fallback).toMatch(/^jsonld:[a-f0-9]{64}$/);
    expect(
      structuredJobExternalId(
        {
          jobLocation: {
            address: {
              addressLocality: "San Francisco",
              addressRegion: "CA",
            },
          },
          title: "Research Scientist",
        },
        "https://acme.com/careers",
      ),
    ).toBe(fallback);
  });

  test("caps adversarial JSON-LD job cardinality", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": Array.from({ length: 250 }, (_, index) => ({
        "@type": "JobPosting",
        identifier: `job-${index}`,
        title: `Role ${index}`,
      })),
    })}</script>`;
    const jobs = parseStructuredJobs(html);
    expect(jobs).toHaveLength(100);
    expect(structuredJobExternalId(jobs[0], "https://example.com/jobs")).toBe(
      "job-0",
    );
  });

  test("does not treat WAF or unknown empty careers pages as authoritative", () => {
    const waf = assessHiringSurfaceHtml(
      `<html><head><title>Just a moment...</title></head>
       <body>Verify you are human. Cloudflare Ray ID: fixture</body></html>`,
      "https://example.com/careers",
    );
    expect(waf).toMatchObject({
      candidate: true,
      softBlocked: true,
      trustedForReconciliation: false,
    });

    const unknownEmpty = assessHiringSurfaceHtml(
      `<html><head><title>Careers</title></head>
       <body><main id="jobs-root">Open positions</main></body></html>`,
      "https://example.com/careers",
    );
    expect(unknownEmpty).toMatchObject({
      candidate: true,
      softBlocked: false,
      explicitEmpty: false,
      trustedForReconciliation: false,
    });

    const explicitEmpty = assessHiringSurfaceHtml(
      `<html><head><title>Careers</title></head>
       <body>We do not currently have any open positions.</body></html>`,
      "https://example.com/careers",
    );
    expect(explicitEmpty).toMatchObject({
      candidate: true,
      softBlocked: false,
      explicitEmpty: true,
      trustedForReconciliation: true,
    });

    const company = upsertCompany({
      name: "Soft 200 Reconciliation",
      domain: "soft-200-reconciliation.example",
    });
    upsertJob({
      companyId: company.id,
      externalId: "valid-existing-role",
      title: "Valid Existing Role",
      sourceType: "company_website",
    });
    expect(
      reconcileCompanyWebsiteJobs(
        company.id,
        [],
        unknownEmpty.trustedForReconciliation,
      ),
    ).toBe(false);
    expect(getCompany(company.id)?.jobs[0].active).toBe(true);
    expect(
      reconcileCompanyWebsiteJobs(
        company.id,
        [],
        waf.trustedForReconciliation,
      ),
    ).toBe(false);
    expect(getCompany(company.id)?.jobs[0].active).toBe(true);
    expect(
      reconcileCompanyWebsiteJobs(
        company.id,
        [],
        explicitEmpty.trustedForReconciliation,
      ),
    ).toBe(true);
    expect(getCompany(company.id)?.jobs[0].active).toBe(false);
  });

  test("deactivates missing website jobs only after a complete crawl", () => {
    const company = upsertCompany({
      name: "Website Job Reconciliation",
      domain: "website-job-reconciliation.example",
    });
    upsertJob({
      companyId: company.id,
      externalId: "still-open",
      title: "Still Open",
      sourceType: "company_website",
    });
    upsertJob({
      companyId: company.id,
      externalId: "removed",
      title: "Removed",
      sourceType: "company_website",
    });

    expect(
      reconcileCompanyWebsiteJobs(company.id, ["still-open"], false),
    ).toBe(false);
    expect(getCompany(company.id)?.jobs.filter((job) => job.active)).toHaveLength(
      2,
    );

    expect(
      reconcileCompanyWebsiteJobs(company.id, ["still-open"], true),
    ).toBe(true);
    expect(
      getDatabase()
        .query(
          `SELECT external_id, active FROM jobs
           WHERE company_id = ? AND source_type = 'company_website'
           ORDER BY external_id`,
        )
        .all(company.id),
    ).toEqual([
      { external_id: "removed", active: 0 },
      { external_id: "still-open", active: 1 },
    ]);

    upsertJob({
      companyId: company.id,
      externalId: "removed",
      title: "Removed",
      sourceType: "company_website",
    });
    const manyObserved = [
      "still-open",
      "removed",
      ...Array.from({ length: 1_200 }, (_, index) => `not-stored-${index}`),
    ];
    expect(
      reconcileCompanyWebsiteJobs(company.id, manyObserved, true),
    ).toBe(true);
    expect(
      getCompany(company.id)?.jobs.filter((job) => job.active),
    ).toHaveLength(2);

    expect(
      reconcileCompanyWebsiteJobs(company.id, ["still-open"], true, true),
    ).toBe(false);
    expect(
      getCompany(company.id)?.jobs.filter((job) => job.active),
    ).toHaveLength(2);
  });
});

describe("discovery failure reporting", () => {
  test("marks an all-failed website batch failed with company context", async () => {
    const company = upsertCompany({
      name: "Blocked Website Fixture",
      websiteUrl: "http://127.0.0.1/",
    });
    const run = await waitForRun(
      startDiscovery({ source: "company_websites", limit: 1 }),
    );

    expect(run.status).toBe("failed");
    expect(run.updatedCount).toBe(0);
    expect(run.skippedCount).toBe(1);
    expect(run.errorMessage).toContain(
      "All 1 company-website research attempts failed.",
    );
    expect(run.errorMessage).toContain("Blocked Website Fixture");
    expect(run.errorMessage).toContain(company.id);
    expect(
      (
        getDatabase()
          .query(
            `SELECT payload_json FROM audit_events
             WHERE event_type = 'discovery.company_failed' AND entity_id = ?`,
          )
          .get(company.id) as { payload_json: string }
      ).payload_json,
    ).toContain(run.id);
  });

  test("marks an all-failed Brave batch failed with company context", async () => {
    const company = upsertCompany({
      name: "Brave Failure Fixture",
      location: "San Francisco, CA",
    });
    saveSecrets({ BRAVE_SEARCH_API_KEY: "fixture-key" });
    globalThis.fetch = (async () => {
      throw new Error("Fixture Brave outage");
    }) as unknown as typeof fetch;

    const run = await waitForRun(
      startDiscovery({
        source: "brave_domains",
        limit: 1,
        autoApplyHighConfidence: false,
      }),
    );

    expect(run.status).toBe("failed");
    expect(run.updatedCount).toBe(0);
    expect(run.skippedCount).toBe(1);
    expect(run.errorMessage).toContain(
      "All 1 Brave domain-resolution attempts failed.",
    );
    expect(run.errorMessage).toContain("Brave Failure Fixture");
    expect(run.errorMessage).toContain(company.id);
    expect(run.errorMessage).toContain(
      "Brave Search could not be reached. Try again later.",
    );
    expect(
      (
        getDatabase()
          .query(
            `SELECT payload_json FROM audit_events
             WHERE event_type = 'discovery.company_failed' AND entity_id = ?`,
          )
          .get(company.id) as { payload_json: string }
      ).payload_json,
    ).toContain("Brave Search could not be reached");
  });
});

describe("CSV evidence minimization", () => {
  test("retains recognized provenance fields but excludes unmapped columns", () => {
    importCsv(
      [
        "Company,Website,Contact,Email,Private SSN,Internal API Token",
        "Minimized Evidence,https://minimized-evidence.example,Ada Example,ada@minimized-evidence.example,123-45-6789,do-not-retain",
      ].join("\n"),
      "Evidence minimization fixture",
    );

    const payloads = (
      getDatabase()
        .query(
          `SELECT payload_json FROM evidence
           WHERE source_type = 'csv' ORDER BY entity_type`,
        )
        .all() as Array<{ payload_json: string }>
    ).map((item) => JSON.parse(item.payload_json) as Record<string, unknown>);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      const serialized = JSON.stringify(payload);
      expect(serialized).toContain("Minimized Evidence");
      expect(serialized).toContain("ada@minimized-evidence.example");
      expect(serialized).not.toContain("Private SSN");
      expect(serialized).not.toContain("123-45-6789");
      expect(serialized).not.toContain("Internal API Token");
      expect(serialized).not.toContain("do-not-retain");
    }
  });
});
