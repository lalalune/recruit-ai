import {
  addEvidence,
  deactivateMissingJobs,
  getCompany,
  patchCompany,
  upsertCompany,
  upsertJob,
} from "../repository";
import { cleanText, fetchWithTimeout, truncate } from "./http";

interface IngestResult {
  inserted: number;
  updated: number;
  skipped: number;
}

function selectedOrNewCompany(
  companyId: string | undefined,
  input: Parameters<typeof upsertCompany>[0],
) {
  if (!companyId) return upsertCompany(input);
  const company = getCompany(companyId);
  if (!company) throw new Error("The selected company no longer exists.");
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
      throw new Error("Enter a valid public job-board identifier or URL.");
    }
    if (!allowedHosts.includes(parsed.hostname.toLowerCase())) {
      throw new Error(
        `This URL is not hosted by ${allowedHosts.join(" or ")}.`,
      );
    }
    slug = parsed.pathname.split("/").filter(Boolean)[0] || "";
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,199}$/i.test(slug)) {
    throw new Error("The job-board identifier contains unsupported characters.");
  }
  return slug;
}

export async function ingestGreenhouse(
  identifier: string,
  companyId?: string,
): Promise<IngestResult> {
  const slug = normalizeBoardSlug(identifier, [
    "boards.greenhouse.io",
    "job-boards.greenhouse.io",
  ]);
  const boardResponse = await fetchWithTimeout(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`,
  );
  const board = (await boardResponse.json()) as { name?: string; content?: string };
  const jobsResponse = await fetchWithTimeout(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
  );
  const payload = (await jobsResponse.json()) as {
    jobs?: Array<{
      id: number;
      title: string;
      absolute_url?: string;
      first_published?: string;
      updated_at?: string;
      location?: { name?: string };
      departments?: Array<{ name?: string }>;
      content?: string;
    }>;
  };
  const company = selectedOrNewCompany(companyId, {
    name: board.name || humanizeIdentifier(slug),
    description: cleanText(board.content),
    status: "ready_for_review",
    priority: "high",
  });
  let jobInserted = 0;
  let jobUpdated = 0;
  for (const job of payload.jobs || []) {
    const result = upsertJob({
      companyId: company.id,
      externalId: String(job.id),
      title: job.title,
      location: job.location?.name || null,
      department: job.departments?.map((item) => item.name).filter(Boolean).join(", ") || null,
      descriptionExcerpt: truncate(cleanText(job.content), 700),
      url: job.absolute_url || null,
      sourceType: "greenhouse",
      postedAt: job.first_published || job.updated_at || null,
    });
    result.inserted ? jobInserted++ : jobUpdated++;
  }
  deactivateMissingJobs(
    company.id,
    "greenhouse",
    (payload.jobs || []).map((job) => String(job.id)),
  );
  addEvidence({
    entityType: "company",
    entityId: company.id,
    fieldName: "hiring_signal",
    value: `${payload.jobs?.length || 0} published Greenhouse jobs`,
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
  };
}

export async function ingestLever(
  identifier: string,
  companyId?: string,
): Promise<IngestResult> {
  const slug = normalizeBoardSlug(identifier, ["jobs.lever.co"]);
  const response = await fetchWithTimeout(
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
  );
  const jobs = (await response.json()) as Array<{
    id: string;
    text: string;
    hostedUrl?: string;
    createdAt?: number;
    descriptionPlain?: string;
    categories?: {
      location?: string;
      department?: string;
      team?: string;
      allLocations?: string[];
    };
  }>;
  const company = selectedOrNewCompany(companyId, {
    name: humanizeIdentifier(slug),
    status: "ready_for_review",
    priority: "high",
  });
  for (const job of jobs) {
    upsertJob({
      companyId: company.id,
      externalId: job.id,
      title: job.text,
      location:
        job.categories?.allLocations?.join(", ") ||
        job.categories?.location ||
        null,
      department: job.categories?.department || job.categories?.team || null,
      descriptionExcerpt: truncate(job.descriptionPlain || "", 700),
      url: job.hostedUrl || null,
      sourceType: "lever",
      postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
    });
  }
  deactivateMissingJobs(
    company.id,
    "lever",
    jobs.map((job) => job.id),
  );
  addEvidence({
    entityType: "company",
    entityId: company.id,
    fieldName: "hiring_signal",
    value: `${jobs.length} published Lever jobs`,
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
  };
}

export async function ingestAshby(
  identifier: string,
  companyId?: string,
): Promise<IngestResult> {
  const slug = normalizeBoardSlug(identifier, ["jobs.ashbyhq.com"]);
  const response = await fetchWithTimeout(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
  );
  const payload = (await response.json()) as {
    jobs?: Array<{
      title: string;
      location?: string;
      department?: string;
      team?: string;
      isListed?: boolean;
      descriptionPlain?: string;
      publishedAt?: string;
      jobUrl?: string;
    }>;
  };
  const company = selectedOrNewCompany(companyId, {
    name: humanizeIdentifier(slug),
    status: "ready_for_review",
    priority: "high",
  });
  let skipped = 0;
  const listedJobs = (payload.jobs || []).filter((job) => {
    if (job.isListed === false) {
      skipped++;
      return false;
    }
    return true;
  });
  for (const job of listedJobs) {
    upsertJob({
      companyId: company.id,
      externalId: job.jobUrl || `${job.title}:${job.location || ""}`,
      title: job.title,
      location: job.location || null,
      department: job.department || job.team || null,
      descriptionExcerpt: truncate(job.descriptionPlain || "", 700),
      url: job.jobUrl || null,
      sourceType: "ashby",
      postedAt: job.publishedAt || null,
    });
  }
  deactivateMissingJobs(
    company.id,
    "ashby",
    listedJobs.map((job) => job.jobUrl || `${job.title}:${job.location || ""}`),
  );
  addEvidence({
    entityType: "company",
    entityId: company.id,
    fieldName: "hiring_signal",
    value: `${listedJobs.length} public Ashby jobs`,
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
  };
}
