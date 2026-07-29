import {
  addEvidence,
  deactivateMissingJobs,
  getCompany,
  patchCompany,
  upsertCompany,
  upsertJob,
} from "../repository";
import { createHash } from "node:crypto";
import { getDatabase } from "../database";
import { z } from "zod";
import { badRequest, conflict, notFound, upstreamFailure } from "../errors";
import {
  cleanText,
  fetchProviderResponse,
  readBoundedJson,
  truncate,
} from "./http";

interface IngestResult {
  inserted: number;
  updated: number;
  skipped: number;
  jobsObserved: number;
}

export interface BoardIngestOptions {
  maxJobs?: number;
  ownership?: {
    confidence: number;
    sourceUrl: string;
  };
  expectedCompany?: {
    name: string;
    domain: string | null;
    websiteUrl: string | null;
    updatedAt: string;
  };
}

type PreparedJob = {
  externalId: string;
  title: string;
  location: string | null;
  department: string | null;
  descriptionExcerpt: string | null;
  url: string;
  sourceType: "greenhouse" | "lever" | "ashby";
  postedAt: string | null;
};

const MAX_BOARD_JOBS = 500;
const MIN_AUTOMATIC_OWNERSHIP_CONFIDENCE = 0.7;
const BoardText = z.string().max(200_000);
const BoardUrl = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Expected a public HTTP(S) URL.");
const GreenhouseBoardSchema = z.object({
  name: z.string().max(500).optional(),
  content: BoardText.optional(),
});
const BoardJobTitle = z.string().trim().min(1).max(500);
const GreenhouseJobsSchema = z.object({
  jobs: z
    .array(
      z.object({
        id: z.union([
          z.number().int(),
          z.string().trim().min(1).max(200),
        ]),
        title: BoardJobTitle,
        absolute_url: BoardUrl,
        first_published: z.string().max(100).optional(),
        updated_at: z.string().max(100).optional(),
        location: z.object({ name: z.string().max(1_000).optional() }).optional(),
        departments: z
          .array(z.object({ name: z.string().max(1_000).optional() }))
          .max(100)
          .optional(),
        content: BoardText.optional(),
      }),
    )
    .max(MAX_BOARD_JOBS)
    .optional(),
});
const LeverJobsSchema = z
  .array(
    z.object({
      id: z.string().trim().min(1).max(500),
      text: BoardJobTitle,
      hostedUrl: BoardUrl,
      createdAt: z
        .number()
        .int()
        .nonnegative()
        .max(4_102_444_800_000)
        .optional(),
      descriptionPlain: BoardText.optional(),
      categories: z
        .object({
          location: z.string().max(1_000).optional(),
          department: z.string().max(1_000).optional(),
          team: z.string().max(1_000).optional(),
          allLocations: z.array(z.string().max(1_000)).max(100).optional(),
        })
        .optional(),
    }),
  )
  .max(MAX_BOARD_JOBS);
const AshbyJobsSchema = z.object({
  jobs: z
    .array(
      z.object({
        title: BoardJobTitle,
        location: z.string().max(1_000).optional(),
        department: z.string().max(1_000).optional(),
        team: z.string().max(1_000).optional(),
        isListed: z.boolean().optional(),
        descriptionPlain: BoardText.optional(),
        publishedAt: z.string().max(100).optional(),
        jobUrl: BoardUrl.optional(),
      }),
    )
    .max(MAX_BOARD_JOBS)
    .optional(),
});

async function boardJson<T>(
  provider: string,
  url: string,
  schema: Parameters<typeof readBoundedJson<T>>[2],
  maximumBytes = 20_000_000,
) {
  const response = await fetchProviderResponse(provider, url, {}, 30_000);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw upstreamFailure(
      `${provider} rejected the request (HTTP ${response.status}).`,
      "job_board_request_rejected",
    );
  }
  return readBoundedJson(response, provider, schema, maximumBytes);
}

function boundedJobLimit(options?: BoardIngestOptions) {
  return Math.min(
    MAX_BOARD_JOBS,
    Math.max(1, Math.trunc(Number(options?.maxJobs) || MAX_BOARD_JOBS)),
  );
}

function assertWithinJobBudget(
  provider: string,
  count: number,
  options?: BoardIngestOptions,
) {
  const maximum = boundedJobLimit(options);
  if (count > maximum) {
    throw upstreamFailure(
      `${provider} returned ${count} jobs, exceeding the ${maximum}-job budget. No board data was saved.`,
      "job_board_budget_exceeded",
    );
  }
}

function assertSelectedBoardAssociation(
  companyId: string | undefined,
  options?: BoardIngestOptions,
) {
  if (!companyId) return;
  const company = getCompany(companyId);
  if (!company) throw notFound("The selected company no longer exists.");
  const expected = options?.expectedCompany;
  if (
    expected &&
    (company.name !== expected.name ||
      company.domain !== expected.domain ||
      company.websiteUrl !== expected.websiteUrl ||
      company.updatedAt !== expected.updatedAt)
  ) {
    throw conflict(
      "The company changed while the job board was loading. The stale result was discarded.",
      "stale_provider_result",
    );
  }
  const ownership = options?.ownership;
  if (!ownership) return;
  if (
    !Number.isFinite(ownership.confidence) ||
    ownership.confidence < MIN_AUTOMATIC_OWNERSHIP_CONFIDENCE ||
    ownership.confidence > 1
  ) {
    throw conflict(
      "The detected job board is not confidently associated with this company. Review it manually before importing.",
      "job_board_ownership_unconfirmed",
    );
  }
  let source: URL;
  try {
    source = new URL(ownership.sourceUrl);
  } catch {
    throw conflict(
      "The job-board ownership source is invalid.",
      "job_board_ownership_unconfirmed",
    );
  }
  if (!["http:", "https:"].includes(source.protocol)) {
    throw conflict(
      "The job-board ownership source must be a public HTTP(S) company page.",
      "job_board_ownership_unconfirmed",
    );
  }
  const companyHost = (
    company.domain ||
    (() => {
      try {
        return company.websiteUrl ? new URL(company.websiteUrl).hostname : "";
      } catch {
        return "";
      }
    })()
  )
    .replace(/^www\./, "")
    .toLowerCase();
  const sourceHost = source.hostname.replace(/^www\./, "").toLowerCase();
  if (
    !companyHost ||
    (sourceHost !== companyHost && !sourceHost.endsWith(`.${companyHost}`))
  ) {
    throw conflict(
      "The detected job board was not linked from the selected company’s confirmed website.",
      "job_board_ownership_unconfirmed",
    );
  }
}

function assertProviderJobUrl(
  provider: "lever" | "ashby",
  url: string,
  slug: string,
) {
  const parsed = new URL(url);
  const expectedHost =
    provider === "lever" ? "jobs.lever.co" : "jobs.ashbyhq.com";
  const urlSlug = parsed.pathname.split("/").filter(Boolean)[0] || "";
  if (
    parsed.hostname.toLowerCase() !== expectedHost ||
    urlSlug.toLowerCase() !== encodeURIComponent(slug).toLowerCase()
  ) {
    throw upstreamFailure(
      `${provider === "lever" ? "Lever" : "Ashby"} returned a job URL for a different board. No board data was saved.`,
      "job_board_ownership_mismatch",
    );
  }
}

function assertUniqueJobIds(provider: string, jobs: PreparedJob[]) {
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.externalId)) {
      throw upstreamFailure(
        `${provider} returned duplicate job identifiers. No board data was saved.`,
        "job_board_payload_invalid",
      );
    }
    seen.add(job.externalId);
  }
}

function normalizedDate(value?: string | null) {
  return value && Number.isFinite(Date.parse(value))
    ? value.trim().slice(0, 100)
    : null;
}

function normalizedExternalId(value: string) {
  const normalized = value.trim();
  return normalized.length <= 2_000
    ? normalized
    : `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

function selectedOrNewCompany(
  companyId: string | undefined,
  input: Parameters<typeof upsertCompany>[0],
) {
  if (!companyId) return upsertCompany(input);
  const company = getCompany(companyId);
  if (!company) throw notFound("The selected company no longer exists.");
  patchCompany(companyId, {
    ...(input.description ? { description: company.description || input.description } : {}),
    status: company.status === "new" ? "ready_for_review" : company.status,
    priority: "high",
  });
  return { id: companyId, inserted: false };
}

function humanizeIdentifier(identifier: string) {
  return identifier
    .replace(/^https?:\/\/[^/]+\//, "")
    .split(/[/?#]/)[0]
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeBoardSlug(
  identifier: string,
  allowedHosts: string[],
) {
  const value = identifier.trim();
  let slug = value;
  if (value.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw badRequest("Enter a valid public job-board identifier or URL.");
    }
    if (!allowedHosts.includes(parsed.hostname.toLowerCase())) {
      throw badRequest(
        `This URL is not hosted by ${allowedHosts.join(" or ")}.`,
      );
    }
    slug = parsed.pathname.split("/").filter(Boolean)[0] || "";
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,199}$/i.test(slug)) {
    throw badRequest("The job-board identifier contains unsupported characters.");
  }
  return slug;
}

export async function ingestGreenhouse(
  identifier: string,
  companyId?: string,
  options?: BoardIngestOptions,
): Promise<IngestResult> {
  const slug = normalizeBoardSlug(identifier, [
    "boards.greenhouse.io",
    "job-boards.greenhouse.io",
  ]);
  const board = await boardJson(
    "Greenhouse",
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`,
    GreenhouseBoardSchema,
    1_000_000,
  );
  const payload = await boardJson(
    "Greenhouse",
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
    GreenhouseJobsSchema,
  );
  const jobs: PreparedJob[] = (payload.jobs || []).map((job) => ({
    externalId: normalizedExternalId(String(job.id)),
    title: job.title.trim(),
    location: truncate(cleanText(job.location?.name), 500) || null,
    department:
      truncate(
        cleanText(
          job.departments?.map((item) => item.name).filter(Boolean).join(", "),
        ),
        500,
      ) || null,
    descriptionExcerpt: truncate(cleanText(job.content), 700) || null,
    url: job.absolute_url,
    sourceType: "greenhouse",
    postedAt: normalizedDate(job.first_published || job.updated_at),
  }));
  assertWithinJobBudget("Greenhouse", jobs.length, options);
  assertUniqueJobIds("Greenhouse", jobs);
  assertSelectedBoardAssociation(companyId, options);

  return getDatabase().transaction(() => {
    const company = selectedOrNewCompany(companyId, {
      name: (board.name || humanizeIdentifier(slug)).slice(0, 500),
      description: truncate(cleanText(board.content), 20_000),
      status: "ready_for_review",
      priority: "high",
    });
    for (const job of jobs) {
      upsertJob({
        companyId: company.id,
        ...job,
      });
    }
    deactivateMissingJobs(
      company.id,
      "greenhouse",
      jobs.map((job) => job.externalId),
    );
    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "hiring_signal",
      value: `${jobs.length} published Greenhouse jobs`,
      sourceType: "greenhouse",
      sourceLabel: "Greenhouse Job Board",
      sourceUrl: `https://boards.greenhouse.io/${slug}`,
      confidence: 0.95,
      payload,
    });
    return {
      inserted: company.inserted ? 1 : 0,
      updated: company.inserted ? 0 : 1,
      skipped: 0,
      jobsObserved: jobs.length,
    };
  })();
}

export async function ingestLever(
  identifier: string,
  companyId?: string,
  options?: BoardIngestOptions,
): Promise<IngestResult> {
  const slug = normalizeBoardSlug(identifier, ["jobs.lever.co"]);
  const jobs = await boardJson(
    "Lever",
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    LeverJobsSchema,
  );
  const preparedJobs: PreparedJob[] = jobs.map((job) => {
    assertProviderJobUrl("lever", job.hostedUrl, slug);
    return {
      externalId: normalizedExternalId(job.id),
      title: job.text.trim(),
      location:
        truncate(
          cleanText(
            job.categories?.allLocations?.join(", ") ||
              job.categories?.location,
          ),
          500,
        ) || null,
      department:
        truncate(
          cleanText(
            job.categories?.department || job.categories?.team,
          ),
          500,
        ) || null,
      descriptionExcerpt:
        truncate(cleanText(job.descriptionPlain), 700) || null,
      url: job.hostedUrl,
      sourceType: "lever",
      postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
    };
  });
  assertWithinJobBudget("Lever", preparedJobs.length, options);
  assertUniqueJobIds("Lever", preparedJobs);
  assertSelectedBoardAssociation(companyId, options);

  return getDatabase().transaction(() => {
    const company = selectedOrNewCompany(companyId, {
      name: humanizeIdentifier(slug).slice(0, 500),
      status: "ready_for_review",
      priority: "high",
    });
    for (const job of preparedJobs) {
      upsertJob({
        companyId: company.id,
        ...job,
      });
    }
    deactivateMissingJobs(
      company.id,
      "lever",
      preparedJobs.map((job) => job.externalId),
    );
    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "hiring_signal",
      value: `${preparedJobs.length} published Lever jobs`,
      sourceType: "lever",
      sourceLabel: "Lever Postings",
      sourceUrl: `https://jobs.lever.co/${slug}`,
      confidence: 0.95,
      payload: jobs,
    });
    return {
      inserted: company.inserted ? 1 : 0,
      updated: company.inserted ? 0 : 1,
      skipped: 0,
      jobsObserved: preparedJobs.length,
    };
  })();
}

export async function ingestAshby(
  identifier: string,
  companyId?: string,
  options?: BoardIngestOptions,
): Promise<IngestResult> {
  const slug = normalizeBoardSlug(identifier, ["jobs.ashbyhq.com"]);
  const payload = await boardJson(
    "Ashby",
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
    AshbyJobsSchema,
  );
  let skipped = 0;
  const listedJobs = (payload.jobs || []).filter((job) => {
    if (job.isListed === false) {
      skipped++;
      return false;
    }
    return true;
  });
  const preparedJobs: PreparedJob[] = listedJobs.map((job) => {
    if (!job.jobUrl) {
      throw upstreamFailure(
        "Ashby returned a listed job without its board URL. No board data was saved.",
        "job_board_payload_invalid",
      );
    }
    assertProviderJobUrl("ashby", job.jobUrl, slug);
    return {
      externalId: normalizedExternalId(job.jobUrl),
      title: job.title.trim(),
      location: truncate(cleanText(job.location), 500) || null,
      department:
        truncate(cleanText(job.department || job.team), 500) || null,
      descriptionExcerpt:
        truncate(cleanText(job.descriptionPlain), 700) || null,
      url: job.jobUrl,
      sourceType: "ashby",
      postedAt: normalizedDate(job.publishedAt),
    };
  });
  assertWithinJobBudget("Ashby", preparedJobs.length, options);
  assertUniqueJobIds("Ashby", preparedJobs);
  assertSelectedBoardAssociation(companyId, options);

  return getDatabase().transaction(() => {
    const company = selectedOrNewCompany(companyId, {
      name: humanizeIdentifier(slug).slice(0, 500),
      status: "ready_for_review",
      priority: "high",
    });
    for (const job of preparedJobs) {
      upsertJob({
        companyId: company.id,
        ...job,
      });
    }
    deactivateMissingJobs(
      company.id,
      "ashby",
      preparedJobs.map((job) => job.externalId),
    );
    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "hiring_signal",
      value: `${preparedJobs.length} public Ashby jobs`,
      sourceType: "ashby",
      sourceLabel: "Ashby public job board",
      sourceUrl: `https://jobs.ashbyhq.com/${slug}`,
      confidence: 0.95,
      payload: { ...payload, jobs: listedJobs },
    });
    return {
      inserted: company.inserted ? 1 : 0,
      updated: company.inserted ? 0 : 1,
      skipped,
      jobsObserved: preparedJobs.length,
    };
  })();
}
