import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testProviderConnection } from "../src/server/connections";
import { closeDatabase, getDatabase } from "../src/server/database";
import {
  addContact,
  getCompany,
  getContact,
  isSuppressed,
  patchCompany,
  patchContact,
  upsertCompany,
  upsertJob,
} from "../src/server/repository";
import { saveSecrets, type SecretKey } from "../src/server/secrets";
import {
  discoverApollo,
  enrichCompanyWithApollo,
} from "../src/server/sources/apollo";
import { discoverDataSf } from "../src/server/sources/datasf";
import {
  findEmailWithHunter,
  verifyEmailWithHunter,
  verifyEmailWithZeroBounce,
} from "../src/server/sources/email";
import { discoverHackerNews } from "../src/server/sources/hackernews";
import { fetchWithTimeout } from "../src/server/sources/http";
import {
  ingestAshby,
  ingestGreenhouse,
  ingestLever,
} from "../src/server/sources/jobBoards";
import { resolveCompanyDomainWithBrave } from "../src/server/sources/webSearch";
import type { EmailStatus } from "../src/shared/types";

type MockFetchHandler = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response>;

const providerKeys: SecretKey[] = [
  "APOLLO_API_KEY",
  "HUNTER_API_KEY",
  "ZEROBOUNCE_API_KEY",
  "SOCRATA_APP_TOKEN",
  "BRAVE_SEARCH_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
];

let testDataDir = "";
let originalDataDir: string | undefined;
let originalFetch: typeof fetch;
const originalProviderEnvironment = new Map<string, string | undefined>();

function mockFetch(handler: MockFetchHandler) {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] = {},
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    const requestInit =
      input instanceof Request
        ? {
            method: input.method,
            headers: input.headers,
            body: init?.body,
            ...init,
          }
        : init || {};
    return handler(url, requestInit);
  }) as typeof fetch;
}

function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, { status, headers });
}

function header(init: RequestInit, name: string) {
  return new Headers(init.headers).get(name);
}

function createCompany(
  name: string,
  domain: string | null = `${name.toLowerCase().replaceAll(" ", "-")}.example`,
  employeeCountMax = 20,
) {
  return upsertCompany({
    name,
    domain,
    websiteUrl: domain ? `https://${domain}` : null,
    location: "San Francisco, CA",
    employeeCountMin: 3,
    employeeCountMax,
    industries: ["Technology"],
  });
}

function createContact(
  companyId: string,
  fullName: string,
  email: string | null,
) {
  const contact = addContact(companyId, {
    fullName,
    title: "Founder and CEO",
    email,
    emailType: email ? "work" : "unknown",
    status: "primary",
  });
  if (!contact) throw new Error("Could not create adapter-test contact.");
  return contact;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalDataDir = process.env.RECRUITAI_DATA_DIR;
  testDataDir = mkdtempSync(path.join(tmpdir(), "recruit-ai-adapters-"));
  closeDatabase();
  process.env.RECRUITAI_DATA_DIR = testDataDir;
  for (const key of providerKeys) {
    originalProviderEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
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
  for (const key of providerKeys) {
    const value = originalProviderEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalProviderEnvironment.clear();
  if (testDataDir.startsWith(path.join(tmpdir(), "recruit-ai-adapters-"))) {
    rmSync(testDataDir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 50,
    });
  }
});

describe("shared provider HTTP behavior", () => {
  test("retries 429 and 5xx responses before returning a successful payload", async () => {
    const statuses = [429, 503, 200];
    const attempts: Array<{ url: string; authorization: string | null }> = [];
    mockFetch((url, init) => {
      attempts.push({
        url,
        authorization: header(init, "authorization"),
      });
      const status = statuses.shift()!;
      return status === 200
        ? json({ ok: true })
        : new Response("retry", {
            status,
            statusText: status === 429 ? "Too Many Requests" : "Unavailable",
            headers: { "Retry-After": "0.001" },
          });
    });

    const response = await fetchWithTimeout(
      "https://provider.example/resource",
      { headers: { Authorization: "Bearer fixture" } },
      1_000,
    );
    expect(await response.json()).toEqual({ ok: true });
    expect(attempts).toHaveLength(3);
    expect(
      attempts.every((attempt) => attempt.authorization === "Bearer fixture"),
    ).toBe(true);
  });

  test("fails after three retryable responses and surfaces malformed JSON", async () => {
    let attempts = 0;
    mockFetch(() => {
      attempts += 1;
      return new Response("unavailable", {
        status: 500,
        statusText: "Server Error",
        headers: { "Retry-After": "0.001" },
      });
    });
    await expect(
      fetchWithTimeout("https://provider.example/failing", {}, 1_000),
    ).rejects.toThrow("500 Server Error");
    expect(attempts).toBe(3);

    mockFetch(
      () =>
        new Response("{not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const malformed = await fetchWithTimeout(
      "https://provider.example/malformed",
      {},
      1_000,
    );
    await expect(malformed.json()).rejects.toThrow();
  });
});

describe("DataSF adapter", () => {
  test("paginates, applies technology/active filters, deduplicates, and records evidence", async () => {
    saveSecrets({ SOCRATA_APP_TOKEN: "socrata-fixture" });
    const requests: Array<{
      offset: string | null;
      token: string | null;
    }> = [];
    mockFetch((url, init) => {
      const parsed = new URL(url);
      requests.push({
        offset: parsed.searchParams.get("$offset"),
        token: header(init, "x-app-token"),
      });
      if (parsed.searchParams.get("$offset") === "0") {
        return json([
          {
            dba_name: "Fixture Robotics",
            full_business_address: "1 Market Street, San Francisco, CA",
            business_zip: "94105",
            naics_code: "541511",
            certificate_number: "fixture-1",
          },
          {
            dba_name: "Fixture Bakery",
            business_zip: "94105",
            naics_code: "311811",
          },
          {
            dba_name: "Fixture Robotics",
            business_zip: "94105",
            naics_code: "541511",
          },
        ]);
      }
      return json([
        {
          dba_name: "Ended Technology",
          business_zip: "94107",
          naics_code: "541511",
          location_end_date: "2001-01-01",
        },
        {
          ownership_name: "Fixture Research",
          city: "San Francisco",
          state: "CA",
          business_zip: "94107",
          naics_code: "541715",
          uniqueid: "fixture-2",
        },
      ]);
    });

    const result = await discoverDataSf(3, true);
    expect(result).toEqual({ inserted: 2, updated: 0, skipped: 3 });
    expect(requests).toEqual([
      { offset: "0", token: "socrata-fixture" },
      { offset: "3", token: "socrata-fixture" },
    ]);
    expect(
      (
        getDatabase()
          .query(
            "SELECT COUNT(*) AS count FROM evidence WHERE source_type = 'datasf'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(2);
  });

  test("returns an empty result and rejects malformed JSON without writing records", async () => {
    mockFetch(() => json([]));
    await expect(discoverDataSf(10, false)).resolves.toEqual({
      inserted: 0,
      updated: 0,
      skipped: 0,
    });

    mockFetch(
      () =>
        new Response("[", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(discoverDataSf(10, false)).rejects.toThrow();
    expect(
      (
        getDatabase()
          .query("SELECT COUNT(*) AS count FROM companies")
          .get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  test("bounds skip-heavy pagination and rejects pages larger than requested", async () => {
    let calls = 0;
    mockFetch((url) => {
      calls++;
      const requested = Number(new URL(url).searchParams.get("$limit"));
      return json(
        Array.from({ length: requested }, (_, index) => ({
          dba_name: `Non-tech ${calls}-${index}`,
          business_zip: "94105",
          naics_code: "722511",
        })),
      );
    });
    await expect(discoverDataSf(2, true)).resolves.toEqual({
      inserted: 0,
      updated: 0,
      skipped: 10,
    });
    expect(calls).toBe(5);

    mockFetch(() =>
      json([
        { dba_name: "One", naics_code: "541511" },
        { dba_name: "Two", naics_code: "541511" },
        { dba_name: "Unexpected extra", naics_code: "541511" },
      ]),
    );
    await expect(discoverDataSf(2, true)).rejects.toMatchObject({
      code: "datasf_payload_invalid",
    });
  });
});

describe("Hacker News adapter", () => {
  test("chooses the newest hiring thread, keeps Bay Area company signals, and skips unsafe leads", async () => {
    const items = new Map<number, unknown>([
      [
        1,
        {
          id: 1,
          type: "story",
          title: "Ask HN: Who is hiring? (June 2026)",
          time: 100,
          kids: [],
        },
      ],
      [
        2,
        {
          id: 2,
          type: "story",
          title: "Ask HN: Who is hiring? (July 2026)",
          time: 200,
          kids: [100, 101, 102, 103],
        },
      ],
      [
        100,
        {
          id: 100,
          type: "comment",
          time: 201,
          text: 'Fixture Compute | Founding Engineer | San Francisco<p><a href="https://fixture-compute.example/jobs">Jobs</a> Contact jobs@fixture-compute.example',
        },
      ],
      [
        101,
        {
          id: 101,
          type: "comment",
          text: "Fixture Staffing Agency | Recruiter | San Francisco",
        },
      ],
      [
        102,
        {
          id: 102,
          type: "comment",
          text: "Remote Only Labs | Engineer | London",
        },
      ],
      [
        103,
        {
          id: 103,
          type: "comment",
          dead: true,
          text: "Dead Labs | Engineer | Oakland",
        },
      ],
    ]);
    mockFetch((url) => {
      if (url.endsWith("/askstories.json")) return json([1, 2]);
      const id = Number(url.match(/item\/(\d+)\.json/)?.[1]);
      return json(items.get(id) ?? null);
    });

    const result = await discoverHackerNews(10);
    expect(result).toEqual({ inserted: 1, updated: 0, skipped: 3 });
    const company = getDatabase()
      .query("SELECT id FROM companies WHERE domain = ?")
      .get("fixture-compute.example") as { id: string };
    expect(getCompany(company.id)).toMatchObject({
      name: "Fixture Compute",
      priority: "high",
      jobs: [
        {
          title: "Founding Engineer",
          sourceType: "hackernews",
        },
      ],
      contacts: [],
    });
  });

  test("fails clearly when no recent hiring thread exists", async () => {
    mockFetch((url) =>
      url.endsWith("/askstories.json")
        ? json([9])
        : json({ id: 9, title: "Ask HN: General discussion", time: 1 }),
    );
    await expect(discoverHackerNews(5)).rejects.toThrow(
      "Could not find a recent Hacker News Who Is Hiring thread",
    );
  });
});

describe("Apollo adapters", () => {
  test("paginates organization discovery, applies configured filters, and omits phone data from evidence", async () => {
    saveSecrets({ APOLLO_API_KEY: "apollo-fixture" });
    const calls: Array<{
      page: string | null;
      perPage: string | null;
      key: string | null;
    }> = [];
    mockFetch((url, init) => {
      const parsed = new URL(url);
      calls.push({
        page: parsed.searchParams.get("page"),
        perPage: parsed.searchParams.get("per_page"),
        key: header(init, "x-api-key"),
      });
      const page = parsed.searchParams.get("page");
      const start = page === "1" ? 0 : 100;
      const count = page === "1" ? 100 : 1;
      return json({
        organizations: Array.from({ length: count }, (_, index) => {
          const number = start + index;
          return {
            id: `apollo-${number}`,
            name: `Apollo Fixture ${number}`,
            primary_domain: `apollo-${number}.example`,
            website_url: `https://apollo-${number}.example`,
            industry: "Artificial Intelligence",
            estimated_num_employees: 12,
            city: "San Francisco",
            state: "CA",
            country: "US",
            phone: "+14155550000",
            num_current_job_postings: 2,
          };
        }),
      });
    });

    const result = await discoverApollo(101);
    expect(result).toEqual({ inserted: 101, updated: 0, skipped: 0 });
    expect(calls).toEqual([
      { page: "1", perPage: "100", key: "apollo-fixture" },
      { page: "2", perPage: "1", key: "apollo-fixture" },
    ]);
    const evidence = getDatabase()
      .query(
        "SELECT payload_json FROM evidence WHERE source_type = 'apollo' LIMIT 1",
      )
      .get() as { payload_json: string };
    expect(evidence.payload_json).not.toContain("+14155550000");
  });

  test("ranks candidates by company size and enriches only the primary without personal email or phone", async () => {
    saveSecrets({ APOLLO_API_KEY: "apollo-fixture" });
    const company = createCompany(
      "Apollo People Fixture",
      "apollo-people.example",
      15,
    );
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      if (url.includes("/mixed_people/api_search")) {
        return json({
          people: [
            { id: "people-1", name: "Casey COO", title: "COO" },
            {
              id: "people-2",
              name: "Taylor Founder",
              title: "Founder and CEO",
            },
            { id: "people-3", name: "Morgan People", title: "Head of People" },
          ],
        });
      }
      expect(url).toContain("/people/match");
      const parsed = new URL(url);
      expect(parsed.searchParams.get("id")).toBe("people-2");
      expect(parsed.searchParams.get("reveal_personal_emails")).toBe("false");
      expect(parsed.searchParams.get("reveal_phone_number")).toBe("false");
      return json({
        person: {
          id: "people-2",
          name: "Taylor Founder",
          first_name: "Taylor",
          last_name: "Founder",
          title: "Founder and CEO",
          email: "taylor@apollo-people.example",
          email_status: "verified",
          linkedin_url: "https://www.linkedin.com/in/taylor-fixture",
        },
      });
    });

    const contacts = await enrichCompanyWithApollo(company.id, 3);
    expect(calls.filter((url) => url.includes("/people/match"))).toHaveLength(
      1,
    );
    expect(contacts).toHaveLength(3);
    expect(contacts[0]).toMatchObject({
      fullName: "Taylor Founder",
      status: "primary",
      rank: 1,
      email: "taylor@apollo-people.example",
      emailStatus: "unverified",
    });
    expect(
      contacts.slice(1).every((contact) => contact.status === "alternate"),
    ).toBe(true);
    expect(contacts.slice(1).every((contact) => contact.email === null)).toBe(
      true,
    );
  });

  test("fails closed for missing credentials and accepts an empty people result", async () => {
    const company = createCompany(
      "Apollo Empty Fixture",
      "apollo-empty.example",
    );
    await expect(discoverApollo(1)).rejects.toThrow("Apollo is not configured");

    saveSecrets({ APOLLO_API_KEY: "apollo-fixture" });
    mockFetch(() => json({ people: [] }));
    await expect(enrichCompanyWithApollo(company.id, 3)).resolves.toEqual([]);
    expect(getCompany(company.id)?.contacts).toEqual([]);
  });

  test("rejects oversized payloads and discards people results after the company anchor changes", async () => {
    saveSecrets({ APOLLO_API_KEY: "apollo-fixture" });
    mockFetch(() =>
      json({
        organizations: Array.from({ length: 101 }, (_, index) => ({
          id: `oversized-${index}`,
          name: `Oversized ${index}`,
        })),
      }),
    );
    await expect(discoverApollo(1)).rejects.toMatchObject({
      code: "upstream_payload_invalid",
    });
    expect(
      (
        getDatabase()
          .query("SELECT COUNT(*) AS count FROM companies")
          .get() as { count: number }
      ).count,
    ).toBe(0);

    const company = createCompany("Apollo Anchor", "apollo-anchor.example");
    let releaseResponse!: (response: Response) => void;
    let signalRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      signalRequest = resolve;
    });
    mockFetch(() => {
      signalRequest();
      return new Promise<Response>((resolve) => {
        releaseResponse = resolve;
      });
    });
    const pending = enrichCompanyWithApollo(company.id, 3);
    await requestStarted;
    patchCompany(company.id, { domain: "changed-apollo-anchor.example" });
    releaseResponse(json({ people: [] }));
    await expect(pending).rejects.toMatchObject({
      code: "stale_provider_result",
    });
    expect(getCompany(company.id)?.contacts).toEqual([]);
  });
});

describe("Brave domain adapter", () => {
  test("filters disallowed hosts, ranks candidates, and applies only a separated high-confidence match", async () => {
    saveSecrets({ BRAVE_SEARCH_API_KEY: "brave-fixture" });
    const company = createCompany("Exact Labs", null);
    mockFetch((url, init) => {
      expect(url).toContain("api.search.brave.com");
      expect(header(init, "x-subscription-token")).toBe("brave-fixture");
      return json({
        web: {
          results: [
            {
              title: "Exact Labs",
              url: "https://exactlabs.com/",
              description: "Exact Labs is an AI company in San Francisco.",
            },
            {
              title: "Exact Labs company profile",
              url: "https://directory.example/exact-labs",
              description: "Company listing.",
            },
            {
              title: "Exact Labs",
              url: "https://www.linkedin.com/company/exact-labs",
            },
            { title: "Broken", url: "not a URL" },
          ],
        },
      });
    });

    const result = await resolveCompanyDomainWithBrave(company.id, true);
    expect(result.applied).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      domain: "exactlabs.com",
      score: 100,
    });
    expect(getCompany(company.id)).toMatchObject({
      domain: "exactlabs.com",
      websiteUrl: "https://exactlabs.com/",
    });
  });

  test("returns no candidates for an empty response and requires a credential", async () => {
    const company = createCompany("Brave Empty Fixture", null);
    await expect(resolveCompanyDomainWithBrave(company.id)).rejects.toThrow(
      "Brave Search is not configured",
    );

    saveSecrets({ BRAVE_SEARCH_API_KEY: "brave-fixture" });
    mockFetch(() => json({ web: { results: [] } }));
    await expect(
      resolveCompanyDomainWithBrave(company.id, true),
    ).resolves.toEqual({
      candidates: [],
      applied: false,
    });
  });

  test("discards a delayed domain result when the company anchor changes", async () => {
    saveSecrets({ BRAVE_SEARCH_API_KEY: "brave-fixture" });
    const company = createCompany("Brave Anchor Fixture", null);
    let releaseResponse!: (response: Response) => void;
    let signalRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      signalRequest = resolve;
    });
    mockFetch(() => {
      signalRequest();
      return new Promise<Response>((resolve) => {
        releaseResponse = resolve;
      });
    });
    const pending = resolveCompanyDomainWithBrave(company.id, true);
    await requestStarted;
    patchCompany(company.id, { name: "Brave Anchor Changed" });
    releaseResponse(
      json({
        web: {
          results: [
            {
              title: "Brave Anchor Fixture",
              url: "https://brave-anchor.example/",
              description: "San Francisco AI company.",
            },
          ],
        },
      }),
    );
    await expect(pending).rejects.toMatchObject({
      code: "stale_provider_result",
    });
    expect(getCompany(company.id)).toMatchObject({
      name: "Brave Anchor Changed",
      domain: null,
    });
    expect(
      (
        getDatabase()
          .query(
            `SELECT COUNT(*) AS count FROM evidence
             WHERE entity_id = ? AND source_type = 'brave_search'`,
          )
          .get(company.id) as { count: number }
      ).count,
    ).toBe(0);
  });
});

describe("public ATS adapters", () => {
  test("ingests and refreshes Greenhouse, Lever, and only public Ashby jobs", async () => {
    const greenhouseCompany = createCompany(
      "Greenhouse Fixture",
      "greenhouse-fixture.example",
    );
    let greenhouseJobFetches = 0;
    mockFetch((url) => {
      if (url.includes("boards-api.greenhouse.io")) {
        if (url.includes("/jobs?")) {
          greenhouseJobFetches += 1;
          return json({
            jobs:
              greenhouseJobFetches === 1
                ? [
                    {
                      id: 42,
                      title: "Robotics Engineer",
                      absolute_url:
                        "https://boards.greenhouse.io/fixture/jobs/42",
                      first_published: "2026-07-01T00:00:00.000Z",
                      location: { name: "San Francisco, CA" },
                      departments: [{ name: "Engineering" }],
                      content: "<p>Build robots.</p>",
                    },
                  ]
                : [],
          });
        }
        return json({
          name: "Greenhouse Fixture",
          content: "<p>Robotics company.</p>",
        });
      }
      if (url.includes("api.lever.co")) {
        return json([
          {
            id: "lever-1",
            text: "Operations Lead",
            hostedUrl: "https://jobs.lever.co/fixture-lever/lever-1",
            createdAt: Date.parse("2026-07-02T00:00:00.000Z"),
            descriptionPlain: "Lead operations.",
            categories: {
              allLocations: ["Oakland, CA", "San Francisco, CA"],
              team: "Operations",
            },
          },
        ]);
      }
      if (url.includes("api.ashbyhq.com")) {
        return json({
          jobs: [
            {
              title: "Research Scientist",
              location: "Berkeley, CA",
              department: "Research",
              isListed: true,
              jobUrl: "https://jobs.ashbyhq.com/fixture-ashby/one",
              descriptionPlain: "Do research.",
              publishedAt: "2026-07-03T00:00:00.000Z",
            },
            {
              title: "Private Draft",
              isListed: false,
              jobUrl: "https://jobs.ashbyhq.com/fixture-ashby/private",
            },
          ],
        });
      }
      throw new Error(`Unexpected ATS request: ${url}`);
    });

    await expect(
      ingestGreenhouse(
        "https://boards.greenhouse.io/fixture",
        greenhouseCompany.id,
      ),
    ).resolves.toEqual({
      inserted: 0,
      updated: 1,
      skipped: 0,
      jobsObserved: 1,
    });
    expect(getCompany(greenhouseCompany.id)?.jobs[0]).toMatchObject({
      title: "Robotics Engineer",
      department: "Engineering",
      active: true,
    });
    await ingestGreenhouse("fixture", greenhouseCompany.id);
    expect(getCompany(greenhouseCompany.id)?.jobs[0].active).toBe(false);

    await expect(
      ingestLever("https://jobs.lever.co/fixture-lever"),
    ).resolves.toEqual({
      inserted: 1,
      updated: 0,
      skipped: 0,
      jobsObserved: 1,
    });
    await expect(
      ingestAshby("https://jobs.ashbyhq.com/fixture-ashby"),
    ).resolves.toEqual({
      inserted: 1,
      updated: 0,
      skipped: 1,
      jobsObserved: 1,
    });

    const sourceCounts = getDatabase()
      .query(
        "SELECT source_type, COUNT(*) AS count FROM jobs GROUP BY source_type ORDER BY source_type",
      )
      .all() as Array<{ source_type: string; count: number }>;
    expect(sourceCounts).toEqual([
      { source_type: "ashby", count: 1 },
      { source_type: "greenhouse", count: 1 },
      { source_type: "lever", count: 1 },
    ]);
  });

  test("rejects unsupported board hosts and malformed provider payloads", async () => {
    await expect(
      ingestGreenhouse("https://attacker.example/fixture"),
    ).rejects.toThrow("not hosted");

    mockFetch(() => json({ jobs: [] }));
    await expect(ingestLever("malformed-lever")).rejects.toThrow();
  });

  test("aligns every ATS title limit with the repository before any write", async () => {
    const oversizedTitle = "x".repeat(501);
    const scenarios = [
      {
        provider: "greenhouse",
        run: (companyId: string) =>
          ingestGreenhouse("atomic-greenhouse", companyId),
        response: (url: string) =>
          url.includes("/jobs?")
            ? json({
                jobs: [
                  {
                    id: 1,
                    title: oversizedTitle,
                    absolute_url:
                      "https://boards.greenhouse.io/atomic-greenhouse/jobs/1",
                  },
                ],
              })
            : json({ name: "Atomic Greenhouse" }),
      },
      {
        provider: "lever",
        run: (companyId: string) => ingestLever("atomic-lever", companyId),
        response: () =>
          json([
            {
              id: "lever-too-long",
              text: oversizedTitle,
              hostedUrl:
                "https://jobs.lever.co/atomic-lever/lever-too-long",
            },
          ]),
      },
      {
        provider: "ashby",
        run: (companyId: string) => ingestAshby("atomic-ashby", companyId),
        response: () =>
          json({
            jobs: [
              {
                title: oversizedTitle,
                isListed: true,
                jobUrl:
                  "https://jobs.ashbyhq.com/atomic-ashby/ashby-too-long",
              },
            ],
          }),
      },
    ] as const;

    for (const scenario of scenarios) {
      const company = createCompany(
        `Atomic title ${scenario.provider}`,
        `atomic-title-${scenario.provider}.example`,
      );
      upsertJob({
        companyId: company.id,
        externalId: "existing",
        title: "Existing role",
        sourceType: scenario.provider,
      });
      mockFetch((url) => scenario.response(url));
      await expect(scenario.run(company.id)).rejects.toMatchObject({
        code: "upstream_payload_invalid",
      });
      expect(getCompany(company.id)?.jobs).toHaveLength(1);
      expect(getCompany(company.id)?.jobs[0]).toMatchObject({
        title: "Existing role",
        active: true,
      });
      expect(
        (
          getDatabase()
            .query(
              `SELECT COUNT(*) AS count FROM evidence
               WHERE entity_id = ? AND source_type = ?`,
            )
            .get(company.id, scenario.provider) as { count: number }
        ).count,
      ).toBe(0);
    }
  });

  test("validates complete ATS payloads before starting atomic board writes", async () => {
    const scenarios = [
      {
        provider: "greenhouse",
        expectedCode: "job_board_payload_invalid",
        run: (companyId: string) =>
          ingestGreenhouse("late-greenhouse", companyId),
        response: (url: string) =>
          url.includes("/jobs?")
            ? json({
                jobs: [
                  {
                    id: 1,
                    title: "First valid role",
                    absolute_url:
                      "https://boards.greenhouse.io/late-greenhouse/jobs/1",
                  },
                  {
                    id: 1,
                    title: "Duplicate identifier",
                    absolute_url:
                      "https://boards.greenhouse.io/late-greenhouse/jobs/2",
                  },
                ],
              })
            : json({ name: "Late Greenhouse" }),
      },
      {
        provider: "lever",
        expectedCode: "job_board_ownership_mismatch",
        run: (companyId: string) => ingestLever("late-lever", companyId),
        response: () =>
          json([
            {
              id: "first",
              text: "First valid role",
              hostedUrl: "https://jobs.lever.co/late-lever/first",
            },
            {
              id: "second",
              text: "Wrong board role",
              hostedUrl: "https://jobs.lever.co/other-company/second",
            },
          ]),
      },
      {
        provider: "ashby",
        expectedCode: "job_board_payload_invalid",
        run: (companyId: string) => ingestAshby("late-ashby", companyId),
        response: () =>
          json({
            jobs: [
              {
                title: "First valid role",
                isListed: true,
                jobUrl: "https://jobs.ashbyhq.com/late-ashby/first",
              },
              {
                title: "Missing URL role",
                isListed: true,
              },
            ],
          }),
      },
    ] as const;

    for (const scenario of scenarios) {
      const company = createCompany(
        `Late validation ${scenario.provider}`,
        `late-validation-${scenario.provider}.example`,
      );
      upsertJob({
        companyId: company.id,
        externalId: "existing",
        title: "Existing role",
        sourceType: scenario.provider,
      });
      mockFetch((url) => scenario.response(url));
      await expect(scenario.run(company.id)).rejects.toMatchObject({
        code: scenario.expectedCode,
      });
      expect(getCompany(company.id)?.jobs).toHaveLength(1);
      expect(getCompany(company.id)?.jobs[0]).toMatchObject({
        title: "Existing role",
        active: true,
      });
    }
  });

  test("rolls back every ATS board when a later database write fails", async () => {
    getDatabase().exec(`
      CREATE TRIGGER fail_atomic_board_job
      BEFORE INSERT ON jobs
      WHEN NEW.external_id LIKE '%atomic-fail%'
      BEGIN
        SELECT RAISE(ABORT, 'fixture late write failure');
      END
    `);
    const scenarios = [
      {
        provider: "greenhouse",
        run: (companyId: string) =>
          ingestGreenhouse("rollback-greenhouse", companyId),
        response: (url: string) =>
          url.includes("/jobs?")
            ? json({
                jobs: [
                  {
                    id: "first",
                    title: "First role",
                    absolute_url:
                      "https://boards.greenhouse.io/rollback-greenhouse/jobs/first",
                  },
                  {
                    id: "atomic-fail",
                    title: "Failing role",
                    absolute_url:
                      "https://boards.greenhouse.io/rollback-greenhouse/jobs/fail",
                  },
                ],
              })
            : json({ name: "Rollback Greenhouse" }),
      },
      {
        provider: "lever",
        run: (companyId: string) => ingestLever("rollback-lever", companyId),
        response: () =>
          json([
            {
              id: "first",
              text: "First role",
              hostedUrl: "https://jobs.lever.co/rollback-lever/first",
            },
            {
              id: "atomic-fail",
              text: "Failing role",
              hostedUrl: "https://jobs.lever.co/rollback-lever/fail",
            },
          ]),
      },
      {
        provider: "ashby",
        run: (companyId: string) => ingestAshby("rollback-ashby", companyId),
        response: () =>
          json({
            jobs: [
              {
                title: "First role",
                isListed: true,
                jobUrl: "https://jobs.ashbyhq.com/rollback-ashby/first",
              },
              {
                title: "Failing role",
                isListed: true,
                jobUrl:
                  "https://jobs.ashbyhq.com/rollback-ashby/atomic-fail",
              },
            ],
          }),
      },
    ] as const;

    for (const scenario of scenarios) {
      const company = createCompany(
        `Rollback ${scenario.provider}`,
        `rollback-${scenario.provider}.example`,
      );
      upsertJob({
        companyId: company.id,
        externalId: "existing",
        title: "Existing role",
        sourceType: scenario.provider,
      });
      const before = getCompany(company.id);
      mockFetch((url) => scenario.response(url));
      await expect(scenario.run(company.id)).rejects.toThrow(
        "fixture late write failure",
      );
      expect(getCompany(company.id)?.jobs).toHaveLength(1);
      expect(getCompany(company.id)?.jobs[0]).toMatchObject({
        title: "Existing role",
        active: true,
      });
      expect(getCompany(company.id)?.updatedAt).toBe(before?.updatedAt);
      expect(
        (
          getDatabase()
            .query(
              `SELECT COUNT(*) AS count FROM evidence
               WHERE entity_id = ? AND source_type = ?`,
            )
            .get(company.id, scenario.provider) as { count: number }
        ).count,
      ).toBe(0);
    }
  });

  test("fails closed on unowned boards and crawl job-budget overflow", async () => {
    const company = createCompany("Owned Board", "owned-board.example");
    upsertJob({
      companyId: company.id,
      externalId: "existing",
      title: "Existing role",
      sourceType: "lever",
    });

    mockFetch(() => json([]));
    await expect(
      ingestLever("owned-board", company.id, {
        ownership: {
          confidence: 0.95,
          sourceUrl: "https://attacker.example/careers",
        },
      }),
    ).rejects.toMatchObject({
      code: "job_board_ownership_unconfirmed",
    });

    mockFetch(() =>
      json([
        {
          id: "one",
          text: "One",
          hostedUrl: "https://jobs.lever.co/owned-board/one",
        },
        {
          id: "two",
          text: "Two",
          hostedUrl: "https://jobs.lever.co/owned-board/two",
        },
      ]),
    );
    await expect(
      ingestLever("owned-board", company.id, {
        maxJobs: 1,
        ownership: {
          confidence: 0.95,
          sourceUrl: "https://owned-board.example/careers",
        },
      }),
    ).rejects.toMatchObject({
      code: "job_board_budget_exceeded",
    });
    expect(getCompany(company.id)?.jobs).toHaveLength(1);
    expect(getCompany(company.id)?.jobs[0]).toMatchObject({
      title: "Existing role",
      active: true,
    });
  });
});

describe("email finder and verifier adapters", () => {
  test("maps Hunter finder/verifier results, retains evidence, and suppresses claimed addresses", async () => {
    saveSecrets({ HUNTER_API_KEY: "hunter-fixture" });
    const company = createCompany("Hunter Fixture", "hunter-fixture.example");
    const foundContact = createContact(company.id, "Alex Finder", null);
    const noResultContact = createContact(company.id, "No Result", null);
    const verifierStatuses = [
      "valid",
      "invalid",
      "accept_all",
      "unknown",
      "webmail",
      "disposable",
      "unexpected",
    ];
    const verifierContacts = verifierStatuses.map((status) =>
      createContact(
        company.id,
        `Verifier ${status}`,
        `${status}@hunter-fixture.example`,
      ),
    );
    const claimed = createContact(
      company.id,
      "Claimed Address",
      "claimed@hunter-fixture.example",
    );

    mockFetch((url, init) => {
      expect(header(init, "authorization")).toBe("Bearer hunter-fixture");
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/email-finder")) {
        return parsed.searchParams.get("full_name") === "Alex Finder"
          ? json({
              data: {
                email: "alex@hunter-fixture.example",
                score: 91,
                verification: {
                  status: "valid",
                  date: "2026-07-20T00:00:00.000Z",
                },
                sources: [{ uri: "https://hunter-fixture.example/team" }],
              },
            })
          : json({ data: {} });
      }
      const email = parsed.searchParams.get("email") || "";
      if (email.startsWith("claimed@")) {
        return json(
          {
            errors: [
              {
                id: "claimed_email",
                details: "Owner requested no processing.",
              },
            ],
          },
          422,
        );
      }
      const status = email.split("@")[0];
      return json({
        data: {
          email,
          status,
          score: status === "valid" ? 99 : 40,
          sources: [{ uri: "https://hunter-fixture.example/source" }],
        },
      });
    });

    await expect(
      findEmailWithHunter(company.id, foundContact.id),
    ).resolves.toMatchObject({
      email: "alex@hunter-fixture.example",
      emailType: "work",
      // Finder evidence is retained, but the changed address still requires a
      // separate verifier action before it can become send-ready.
      emailStatus: "unverified",
      emailVerifiedAt: null,
    });
    await expect(
      findEmailWithHunter(company.id, noResultContact.id),
    ).rejects.toThrow("Hunter did not find an email");

    const expected: EmailStatus[] = [
      "valid",
      "invalid",
      "accept_all",
      "unknown",
      "unknown",
      "disposable",
      "unverified",
    ];
    for (let index = 0; index < verifierContacts.length; index += 1) {
      const result = await verifyEmailWithHunter(verifierContacts[index].id);
      expect(result?.emailStatus).toBe(expected[index]);
      expect(result?.emailVerifiedAt).not.toBeNull();
    }

    await expect(verifyEmailWithHunter(claimed.id)).rejects.toThrow(
      "requested that this address not be processed",
    );
    expect(getContact(claimed.id)?.emailStatus).toBe("do_not_mail");
    expect(isSuppressed("claimed@hunter-fixture.example", "email")).toBe(true);
  });

  test("maps ZeroBounce categories and suppresses do-not-mail outcomes", async () => {
    saveSecrets({ ZEROBOUNCE_API_KEY: "zerobounce-fixture" });
    const company = createCompany(
      "ZeroBounce Fixture",
      "zerobounce-fixture.example",
    );
    const scenarios: Array<{
      local: string;
      payload: Record<string, string>;
      expected: EmailStatus;
    }> = [
      { local: "valid", payload: { status: "valid" }, expected: "valid" },
      { local: "invalid", payload: { status: "invalid" }, expected: "invalid" },
      {
        local: "catchall",
        payload: { status: "catch-all" },
        expected: "accept_all",
      },
      { local: "unknown", payload: { status: "unknown" }, expected: "unknown" },
      {
        local: "disposable",
        payload: { status: "do_not_mail", sub_status: "disposable" },
        expected: "disposable",
      },
      {
        local: "spamtrap",
        payload: { status: "do_not_mail", sub_status: "spamtrap" },
        expected: "do_not_mail",
      },
    ];
    const contacts = scenarios.map((scenario) =>
      createContact(
        company.id,
        `ZeroBounce ${scenario.local}`,
        `${scenario.local}@zerobounce-fixture.example`,
      ),
    );
    mockFetch((url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("api_key")).toBe("zerobounce-fixture");
      const email = parsed.searchParams.get("email") || "";
      const local = email.split("@")[0];
      return json({
        address: email,
        ...scenarios.find((scenario) => scenario.local === local)?.payload,
      });
    });

    for (let index = 0; index < contacts.length; index += 1) {
      const result = await verifyEmailWithZeroBounce(contacts[index].id);
      expect(result?.emailStatus).toBe(scenarios[index].expected);
    }
    expect(isSuppressed("spamtrap@zerobounce-fixture.example", "email")).toBe(
      true,
    );
    expect(isSuppressed("disposable@zerobounce-fixture.example", "email")).toBe(
      false,
    );
  });

  test("fails closed for missing credentials, provider errors, and malformed empty payloads", async () => {
    const company = createCompany(
      "Email Failure Fixture",
      "email-failure.example",
    );
    const contact = createContact(
      company.id,
      "Failure Contact",
      "failure@email-failure.example",
    );
    await expect(verifyEmailWithHunter(contact.id)).rejects.toThrow(
      "Hunter is not configured",
    );
    await expect(verifyEmailWithZeroBounce(contact.id)).rejects.toThrow(
      "ZeroBounce is not configured",
    );

    saveSecrets({ ZEROBOUNCE_API_KEY: "zerobounce-fixture" });
    mockFetch(() => json({ error: "Provider rejected this request." }));
    await expect(verifyEmailWithZeroBounce(contact.id)).rejects.toThrow(
      "ZeroBounce rejected the verification request",
    );

    mockFetch(() => json({}));
    await expect(verifyEmailWithZeroBounce(contact.id)).rejects.toThrow(
      "ZeroBounce returned no verification status",
    );
    expect(isSuppressed("failure@email-failure.example", "email")).toBe(false);
  });

  test("binds verifier responses to the requested address and caps provider bodies", async () => {
    saveSecrets({ ZEROBOUNCE_API_KEY: "zerobounce-fixture" });
    const company = createCompany(
      "Verifier Binding Fixture",
      "verifier-binding.example",
    );
    const contact = createContact(
      company.id,
      "Verifier Binding",
      "expected@verifier-binding.example",
    );

    mockFetch(() =>
      json({
        address: "someone-else@verifier-binding.example",
        status: "valid",
      }),
    );
    await expect(verifyEmailWithZeroBounce(contact.id)).rejects.toMatchObject({
      code: "provider_identity_mismatch",
    });
    expect(getContact(contact.id)).toMatchObject({
      email: "expected@verifier-binding.example",
      emailStatus: "unverified",
      emailVerifiedAt: null,
    });

    mockFetch(() =>
      json({
        address: "expected@verifier-binding.example",
        status: "valid",
        padding: "x".repeat(300_000),
      }),
    );
    await expect(verifyEmailWithZeroBounce(contact.id)).rejects.toMatchObject({
      code: "upstream_payload_too_large",
    });
    expect(getContact(contact.id)?.emailStatus).toBe("unverified");
  });

  test("discards a delayed Hunter finder result when the current contact changes", async () => {
    saveSecrets({ HUNTER_API_KEY: "hunter-fixture" });
    const company = createCompany(
      "Hunter Anchor Fixture",
      "hunter-anchor.example",
    );
    const contact = createContact(company.id, "Anchor Person", null);
    let releaseResponse!: (response: Response) => void;
    let signalRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      signalRequest = resolve;
    });
    mockFetch(() => {
      signalRequest();
      return new Promise<Response>((resolve) => {
        releaseResponse = resolve;
      });
    });

    const pending = findEmailWithHunter(company.id, contact.id);
    await requestStarted;
    patchContact(contact.id, { title: "Chief Operating Officer" });
    releaseResponse(
      json({
        data: {
          email: "anchor@hunter-anchor.example",
          score: 95,
        },
      }),
    );
    await expect(pending).rejects.toMatchObject({
      code: "stale_provider_result",
    });
    expect(getContact(contact.id)).toMatchObject({
      title: "Chief Operating Officer",
      email: null,
    });
  });
});

describe("provider connection checks", () => {
  test("maps successful provider-specific account responses without leaking credentials", async () => {
    saveSecrets({
      APOLLO_API_KEY: "apollo-connection",
      HUNTER_API_KEY: "hunter-connection",
      ZEROBOUNCE_API_KEY: "zerobounce-connection",
      SOCRATA_APP_TOKEN: "socrata-connection",
      BRAVE_SEARCH_API_KEY: "brave-connection",
    });
    const requests: Array<{ url: string; headers: Headers }> = [];
    mockFetch((url, init) => {
      requests.push({ url, headers: new Headers(init.headers) });
      if (url.includes("apollo.io")) {
        return json({ healthy: true, is_logged_in: true });
      }
      if (url.includes("hunter.io")) {
        return json({
          data: {
            plan_name: "Fixture Plan",
            requests: { credits: { available: 321 } },
          },
        });
      }
      if (url.includes("zerobounce.net")) return json({ Credits: 456 });
      if (url.includes("data.sfgov.org")) return json([]);
      if (url.includes("search.brave.com"))
        return json({ web: { results: [] } });
      throw new Error(`Unexpected connection request: ${url}`);
    });

    await expect(testProviderConnection("apollo")).resolves.toMatchObject({
      ok: true,
      detail: "API key authenticated; no credits used.",
    });
    await expect(testProviderConnection("hunter")).resolves.toMatchObject({
      ok: true,
      detail: "Fixture Plan account authenticated · 321 credits available.",
    });
    await expect(testProviderConnection("zerobounce")).resolves.toMatchObject({
      ok: true,
      detail: "456 verification credits available.",
    });
    await expect(testProviderConnection("socrata")).resolves.toMatchObject({
      ok: true,
      detail: "DataSF app token accepted.",
    });
    await expect(testProviderConnection("brave")).resolves.toMatchObject({
      ok: true,
      detail: "Search API authenticated; the test used one query.",
    });

    expect(
      requests
        .find((request) => request.url.includes("apollo.io"))
        ?.headers.get("x-api-key"),
    ).toBe("apollo-connection");
    expect(
      requests
        .find((request) => request.url.includes("hunter.io"))
        ?.headers.get("authorization"),
    ).toBe("Bearer hunter-connection");
    expect(
      requests
        .find((request) => request.url.includes("data.sfgov.org"))
        ?.headers.get("x-app-token"),
    ).toBe("socrata-connection");
    expect(
      requests
        .find((request) => request.url.includes("search.brave.com"))
        ?.headers.get("x-subscription-token"),
    ).toBe("brave-connection");
    expect(
      requests.find((request) => request.url.includes("zerobounce.net"))?.url,
    ).toContain("api_key=zerobounce-connection");
  });

  test("classifies missing credentials, network failures, auth/plan/rate/server errors, and malformed Apollo health", async () => {
    await expect(testProviderConnection("apollo")).rejects.toThrow(
      "Save this provider credential",
    );
    saveSecrets({
      APOLLO_API_KEY: "apollo-connection",
      HUNTER_API_KEY: "hunter-connection",
      ZEROBOUNCE_API_KEY: "zerobounce-connection",
      SOCRATA_APP_TOKEN: "socrata-connection",
      BRAVE_SEARCH_API_KEY: "brave-connection",
    });

    mockFetch((url) => {
      if (url.includes("apollo.io")) return new Response("", { status: 401 });
      if (url.includes("hunter.io")) return new Response("", { status: 403 });
      if (url.includes("zerobounce.net"))
        return new Response("", { status: 429 });
      if (url.includes("data.sfgov.org"))
        return new Response("", { status: 500 });
      throw new Error("offline");
    });
    await expect(testProviderConnection("apollo")).rejects.toThrow(
      "credential was rejected",
    );
    await expect(testProviderConnection("hunter")).rejects.toThrow(
      "lacks the required plan or scope",
    );
    await expect(testProviderConnection("zerobounce")).rejects.toThrow(
      "rate limit was reached",
    );
    await expect(testProviderConnection("socrata")).rejects.toThrow(
      "returned HTTP 500",
    );
    await expect(testProviderConnection("brave")).rejects.toThrow(
      "could not be reached",
    );

    mockFetch(() => json({}));
    await expect(testProviderConnection("apollo")).rejects.toThrow(
      "API key is not logged in",
    );
    mockFetch(
      () =>
        new Response("{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(testProviderConnection("hunter")).rejects.toThrow();
  });
});
