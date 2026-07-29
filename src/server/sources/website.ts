import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { load } from "cheerio";
import robotsParser from "robots-parser";
import { getDatabase } from "../database";
import {
  addContact,
  addEvidence,
  getCompany,
  getSettings,
  patchCompany,
  recomputeCompanyStats,
  upsertJob,
} from "../repository";
import { getSnapshotsDir } from "../paths";
import { badRequest, conflict, notFound } from "../errors";
import {
  cleanText,
  fetchWithValidatedRedirects,
  truncate,
} from "./http";
import {
  ingestAshby,
  ingestGreenhouse,
  ingestLever,
} from "./jobBoards";

const crawlerAgent = "RecruitAIResearch";
const MAX_CRAWL_PAGES = 20;
const MAX_DISCOVERED_CAREER_LINKS = 100;
const MAX_DISCOVERED_BOARDS = 10;
const MAX_ATS_BOARDS_PER_CRAWL = 3;
const MAX_ATS_JOBS_PER_CRAWL = 500;
const MIN_ATS_OWNERSHIP_CONFIDENCE = 0.7;
const MAX_ANCHORS_PER_PAGE = 2_000;
const MAX_MAILTO_ADDRESSES_PER_PAGE = 25;
const MAX_MAILTO_ADDRESSES_PER_CRAWL = 100;
const MAX_JSON_LD_SCRIPTS = 50;
const MAX_JSON_LD_NODES = 20_000;
const MAX_STRUCTURED_JOBS_PER_PAGE = 100;
const MAX_WEBSITE_JOB_IDS = 400;
const MAX_RECONCILIATION_IDS = 10_000;
const SQLITE_PARAMETER_CHUNK = 400;
const likelyPaths = [
  "/",
  "/careers",
  "/jobs",
  "/join-us",
  "/about",
  "/team",
  "/leadership",
  "/contact",
];

type SupportedBoard = {
  provider: "greenhouse" | "lever" | "ashby";
  identifier: string;
  url: string;
  discoveredOn: string;
  linkLabel: string;
  ownershipConfidence: number;
};

type WebsiteCompanyAnchor = {
  name: string;
  domain: string | null;
  websiteUrl: string | null;
  updatedAt: string;
};

function websiteCompanyAnchor(
  company: NonNullable<ReturnType<typeof getCompany>>,
): WebsiteCompanyAnchor {
  return {
    name: company.name,
    domain: company.domain,
    websiteUrl: company.websiteUrl,
    updatedAt: company.updatedAt,
  };
}

function assertWebsiteCompanyUnchanged(
  companyId: string,
  expected: WebsiteCompanyAnchor,
  includeVersion = true,
) {
  const current = getCompany(companyId);
  if (
    !current ||
    current.name !== expected.name ||
    current.domain !== expected.domain ||
    current.websiteUrl !== expected.websiteUrl ||
    (includeVersion && current.updatedAt !== expected.updatedAt)
  ) {
    throw conflict(
      "The company changed while website research was running. The stale result was discarded.",
      "stale_provider_result",
    );
  }
  return current;
}

function supportedBoard(
  url: URL,
): Pick<SupportedBoard, "provider" | "identifier" | "url"> | null {
  const host = url.hostname.toLowerCase();
  const identifier = url.pathname.split("/").filter(Boolean)[0] || "";
  if (!/^[a-z0-9][a-z0-9_-]{0,199}$/i.test(identifier)) return null;
  if (["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(host)) {
    return { provider: "greenhouse", identifier, url: url.toString() };
  }
  if (host === "jobs.lever.co") {
    return { provider: "lever", identifier, url: url.toString() };
  }
  if (host === "jobs.ashbyhq.com") {
    return { provider: "ashby", identifier, url: url.toString() };
  }
  return null;
}

function ownershipToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function boardOwnershipConfidence(
  company: NonNullable<ReturnType<typeof getCompany>>,
  board: Pick<SupportedBoard, "identifier">,
  sourceUrl: string,
  linkLabel: string,
) {
  let score = 0.4;
  const source = new URL(sourceUrl);
  if (
    /\b(career|jobs|join|openings|positions|work with us)\b/i.test(
      `${source.pathname} ${linkLabel}`,
    )
  ) {
    score += 0.3;
  }
  const slug = ownershipToken(board.identifier);
  const companyName = ownershipToken(company.name);
  const companyDomain = ownershipToken(
    (company.domain || "").split(".")[0] || "",
  );
  if (
    slug &&
    [companyName, companyDomain].some(
      (candidate) =>
        candidate &&
        (candidate === slug ||
          (candidate.length >= 5 &&
            slug.length >= 3 &&
            (candidate.includes(slug) || slug.includes(candidate)))),
    )
  ) {
    score += 0.3;
  }
  return Math.min(1, score);
}

type ResolvedPublicAddress = {
  address: string;
  family: 4 | 6;
};

function parseIpv4(address: string) {
  const parts = address.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  ) {
    return null;
  }
  return parts.map(Number);
}

function parseIpv6(address: string) {
  let normalized = address
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split("%")[0]
    .toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
    if (!ipv4) return null;
    normalized = `${normalized.slice(0, lastColon)}:${(
      (ipv4[0] << 8) |
      ipv4[1]
    ).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  if ((normalized.match(/::/g) || []).length > 1) return null;
  const [head = "", tail = ""] = normalized.split("::");
  const readWords = (section: string) =>
    section
      ? section.split(":").map((word) =>
          /^[a-f0-9]{1,4}$/.test(word) ? Number.parseInt(word, 16) : NaN,
        )
      : [];
  const headWords = readWords(head);
  const tailWords = readWords(tail);
  if ([...headWords, ...tailWords].some(Number.isNaN)) return null;
  if (!normalized.includes("::")) {
    return headWords.length === 8 ? headWords : null;
  }
  const missing = 8 - headWords.length - tailWords.length;
  if (missing < 1) return null;
  return [...headWords, ...Array<number>(missing).fill(0), ...tailWords];
}

function ipv4InRange(parts: number[], first: number, prefix: number) {
  const value =
    ((parts[0] << 24) >>> 0) |
    (parts[1] << 16) |
    (parts[2] << 8) |
    parts[3];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((value >>> 0) & mask) === ((first >>> 0) & mask);
}

function ipv6InRange(words: number[], first: bigint, prefix: number) {
  const value = words.reduce(
    (result, word) => (result << 16n) | BigInt(word),
    0n,
  );
  const shift = BigInt(128 - prefix);
  return value >> shift === first >> shift;
}

export function isBlockedNetworkAddress(rawAddress: string) {
  const address = rawAddress.replace(/^\[/, "").replace(/\]$/, "").split("%")[0];
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const value =
      ((ipv4[0] << 24) >>> 0) |
      (ipv4[1] << 16) |
      (ipv4[2] << 8) |
      ipv4[3];
    return [
      [0x00000000, 8],
      [0x0a000000, 8],
      [0x64400000, 10],
      [0x7f000000, 8],
      [0xa9fe0000, 16],
      [0xac100000, 12],
      [0xc0000000, 24],
      [0xc0000200, 24],
      [0xc0586300, 24],
      [0xc0a80000, 16],
      [0xc6120000, 15],
      [0xc6336400, 24],
      [0xcb007100, 24],
      [0xe0000000, 4],
      [0xf0000000, 4],
    ].some(([first, prefix]) => ipv4InRange(ipv4, first, prefix)) ||
      value === 0xffffffff;
  }
  const ipv6 = parseIpv6(address);
  if (!ipv6) return true;
  const mappedIpv4 =
    ipv6.slice(0, 5).every((word) => word === 0) && ipv6[5] === 0xffff
      ? [
          ipv6[6] >> 8,
          ipv6[6] & 0xff,
          ipv6[7] >> 8,
          ipv6[7] & 0xff,
        ]
      : null;
  if (mappedIpv4) {
    return isBlockedNetworkAddress(mappedIpv4.join("."));
  }
  const ranges: Array<[bigint, number]> = [
    [0n, 96],
    [0x0064ff9b000000000000000000000000n, 96],
    [0x0064ff9b000100000000000000000000n, 48],
    [0x01000000000000000000000000000000n, 64],
    [0x20010000000000000000000000000000n, 32],
    [0x20010002000000000000000000000000n, 48],
    [0x20010db8000000000000000000000000n, 32],
    [0x20010010000000000000000000000000n, 28],
    [0x20010020000000000000000000000000n, 28],
    [0x20020000000000000000000000000000n, 16],
    [0x3fff0000000000000000000000000000n, 20],
    [0xfc000000000000000000000000000000n, 7],
    [0xfe800000000000000000000000000000n, 10],
    [0xfec0000000000000000000000000000n, 10],
    [0xff000000000000000000000000000000n, 8],
  ];
  return ranges.some(([first, prefix]) => ipv6InRange(ipv6, first, prefix));
}

export async function assertPublicWebsiteUrl(url: URL) {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw badRequest("Only public HTTP and HTTPS pages can be researched.");
  }
  if (url.username || url.password) {
    throw badRequest("Website URLs cannot contain credentials.");
  }
  const hostname = url.hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const literalFamily = isIP(hostname);
  if (
    hostname === "localhost" ||
    (!literalFamily && !hostname.includes(".")) ||
    [".localhost", ".local", ".localdomain", ".internal", ".lan", ".home.arpa"].some(
      (suffix) => hostname.endsWith(suffix),
    )
  ) {
    throw badRequest("Local network addresses cannot be researched.");
  }
  if (literalFamily) {
    if (isBlockedNetworkAddress(hostname)) {
      throw badRequest("Private or non-public network addresses are blocked.");
    }
    return [{ address: hostname, family: literalFamily as 4 | 6 }];
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some((entry) => isBlockedNetworkAddress(entry.address))
  ) {
    throw badRequest(
      "The domain resolved to a private, non-public, or unavailable address.",
    );
  }
  return addresses.map((entry) => ({
    address: entry.address,
    family: entry.family as 4 | 6,
  })) satisfies ResolvedPublicAddress[];
}

function saveSnapshot(url: string, html: string) {
  const hash = createHash("sha256").update(html).digest("hex");
  const filePath = path.join(getSnapshotsDir(), `${hash}.html`);
  writeFileSync(filePath, html, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(filePath, 0o600);
  return { hash, filePath };
}

function findJobPostings(
  value: unknown,
  limit: number,
): { jobs: Record<string, unknown>[]; truncated: boolean } {
  const jobs: Record<string, unknown>[] = [];
  const stack: unknown[] = [value];
  let visitedNodes = 0;
  let truncated = false;
  while (stack.length) {
    if (visitedNodes >= MAX_JSON_LD_NODES) {
      truncated = true;
      break;
    }
    visitedNodes++;
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        if (stack.length + visitedNodes >= MAX_JSON_LD_NODES) {
          truncated = true;
          break;
        }
        stack.push(current[index]);
      }
      continue;
    }
    const object = current as Record<string, unknown>;
    const type = object["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes("JobPosting")) {
      if (jobs.length >= limit) {
        truncated = true;
        break;
      }
      jobs.push(object);
    }
    const children = Object.values(object);
    for (let index = children.length - 1; index >= 0; index--) {
      if (stack.length + visitedNodes >= MAX_JSON_LD_NODES) {
        truncated = true;
        break;
      }
      stack.push(children[index]);
    }
  }
  return { jobs, truncated };
}

function parseStructuredJobsBounded(
  html: string,
  limit = MAX_STRUCTURED_JOBS_PER_PAGE,
) {
  const $ = load(html);
  const jobs: Record<string, unknown>[] = [];
  let truncated = false;
  const scripts = $('script[type="application/ld+json"]');
  scripts.each((index, element) => {
    if (index >= MAX_JSON_LD_SCRIPTS || jobs.length >= limit) {
      truncated = true;
      return false;
    }
    const raw = $(element).text();
    try {
      const found = findJobPostings(JSON.parse(raw), limit - jobs.length);
      jobs.push(...found.jobs);
      truncated ||= found.truncated;
    } catch {
      // Malformed JSON-LD is common and should not stop the rest of the page.
    }
    if (jobs.length >= limit && index < scripts.length - 1) {
      truncated = true;
      return false;
    }
  });
  return { jobs, truncated };
}

export function parseStructuredJobs(html: string) {
  return parseStructuredJobsBounded(html).jobs;
}

type HiringSurfaceAssessment = {
  candidate: boolean;
  softBlocked: boolean;
  explicitEmpty: boolean;
  trustedForReconciliation: boolean;
  structuredJobCount: number;
};

function assessHiringSurfaceContent(
  pageUrl: string,
  title: string,
  bodyText: string,
  html: string,
  structuredJobCount: number,
): HiringSurfaceAssessment {
  const classifierText = `${title}\n${bodyText.slice(0, 20_000)}`;
  const candidate =
    /\b(?:careers?|jobs?|join(?:[-_]?us)?|openings?|positions?)\b/i.test(
      new URL(pageUrl).pathname,
    ) ||
    /\b(careers at|join our team|open positions|current openings|we(?:'|’)re hiring)\b/i.test(
      classifierText,
    ) ||
    structuredJobCount > 0;
  const softBlocked =
    /^(?:just a moment|attention required|access denied|forbidden|request blocked|security check|service unavailable|temporarily unavailable|verify you are human)\b/i.test(
      title.trim(),
    ) ||
    /\b(?:cf-chl-|challenge-platform|cloudflare ray id|checking your browser|enable javascript and cookies to continue|please wait while we verify|verify (?:that )?you are human|incapsula incident id|akamai reference|perimeterx|px-captcha|request was blocked by the security rules|requested url was rejected)\b/i.test(
      `${html.slice(0, 100_000)}\n${classifierText}`,
    );
  const explicitEmpty =
    /\b(?:no|zero) (?:current(?:ly)? )?(?:open )?(?:jobs|roles|positions|vacancies|openings)\b/i.test(
      classifierText,
    ) ||
    /\b(?:we (?:do not|don't|don’t)|not currently|aren't currently|are not currently) (?:have|offer|list|show)(?: any)? (?:open )?(?:jobs|roles|positions|vacancies|openings)\b/i.test(
      classifierText,
    );
  return {
    candidate,
    softBlocked,
    explicitEmpty,
    trustedForReconciliation:
      candidate &&
      !softBlocked &&
      (structuredJobCount > 0 || explicitEmpty),
    structuredJobCount,
  };
}

export function assessHiringSurfaceHtml(
  html: string,
  pageUrl: string,
): HiringSurfaceAssessment {
  const $ = load(html);
  const title = truncate(cleanText($("title").first().text()), 1_000);
  const bodyText = cleanText($("body").text());
  const structuredJobs = parseStructuredJobsBounded(html);
  return assessHiringSurfaceContent(
    pageUrl,
    title,
    bodyText,
    html,
    structuredJobs.jobs.length,
  );
}

function extractLocation(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  const address = object.address as Record<string, unknown> | undefined;
  if (!address) return null;
  const location = [address.addressLocality, address.addressRegion, address.addressCountry]
    .filter(Boolean)
    .join(", ");
  const normalized = truncate(cleanText(location), 500);
  return normalized || null;
}

function scalarSchemaValue(value: unknown): string | null {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length && visited < 100) {
    visited++;
    const current = stack.pop();
    if (typeof current === "string" || typeof current === "number") {
      const normalized = String(current).trim();
      if (normalized) return normalized.slice(0, 1_000);
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = Math.min(current.length, 100) - 1; index >= 0; index--) {
        stack.push(current[index]);
      }
      continue;
    }
    if (!current || typeof current !== "object") continue;
    const object = current as Record<string, unknown>;
    const keys = ["value", "@id", "identifier", "name"];
    for (let index = keys.length - 1; index >= 0; index--) {
      stack.push(object[keys[index]]);
    }
  }
  return null;
}

export function structuredJobExternalId(
  job: Record<string, unknown>,
  pageUrl: string,
) {
  const identifier = scalarSchemaValue(job.identifier);
  if (identifier) return identifier;

  const jobUrl = scalarSchemaValue(job.url);
  if (jobUrl) {
    try {
      const absoluteUrl = new URL(jobUrl, pageUrl).toString();
      return absoluteUrl.length <= 2_048
        ? absoluteUrl
        : `urlhash:${createHash("sha256").update(absoluteUrl).digest("hex")}`;
    } catch {
      return jobUrl;
    }
  }

  const stableFallback = {
    pageUrl,
    title: scalarSchemaValue(job.title),
    location: scalarSchemaValue(job.jobLocation),
    hiringOrganization: scalarSchemaValue(job.hiringOrganization),
    employmentType: scalarSchemaValue(job.employmentType),
  };
  return `jsonld:${createHash("sha256")
    .update(JSON.stringify(stableFallback))
    .digest("hex")}`;
}

export function reconcileCompanyWebsiteJobs(
  companyId: string,
  observedExternalIds: Iterable<string>,
  crawlComplete: boolean,
  crawlTruncated = false,
) {
  if (!crawlComplete || crawlTruncated) return false;
  const observed: string[] = [];
  const seen = new Set<string>();
  for (const rawExternalId of observedExternalIds) {
    const externalId = String(rawExternalId).trim();
    if (!externalId || externalId.length > 2_048) return false;
    if (seen.has(externalId)) continue;
    if (seen.size >= MAX_RECONCILIATION_IDS) return false;
    seen.add(externalId);
    observed.push(externalId);
  }

  const database = getDatabase();
  const tempTable = "temp_recruitai_observed_website_jobs";
  const changes = database.transaction(() => {
    database.exec(`DROP TABLE IF EXISTS ${tempTable}`);
    database.exec(
      `CREATE TEMP TABLE ${tempTable} (
        external_id TEXT PRIMARY KEY
      ) WITHOUT ROWID`,
    );
    try {
      for (
        let offset = 0;
        offset < observed.length;
        offset += SQLITE_PARAMETER_CHUNK
      ) {
        const chunk = observed.slice(offset, offset + SQLITE_PARAMETER_CHUNK);
        const placeholders = chunk.map(() => "(?)").join(", ");
        database
          .query(
            `INSERT OR IGNORE INTO ${tempTable} (external_id)
             VALUES ${placeholders}`,
          )
          .run(...chunk);
      }
      return database
        .query(
          `UPDATE jobs SET active = 0
           WHERE company_id = ? AND source_type = 'company_website'
             AND active = 1
             AND NOT EXISTS (
               SELECT 1 FROM ${tempTable} observed
               WHERE observed.external_id = jobs.external_id
             )`,
        )
        .run(companyId).changes;
    } finally {
      database.exec(`DROP TABLE IF EXISTS ${tempTable}`);
    }
  })();
  recomputeCompanyStats(companyId);
  if (changes) {
    const current = getCompany(companyId);
    if (current?.reviewed) {
      patchCompany(companyId, {
        reviewed: false,
        status:
          current.status === "approved" ? "ready_for_review" : current.status,
      });
    }
  }
  return true;
}

async function robotsFor(origin: string) {
  const robotsUrl = new URL("/robots.txt", origin).toString();
  try {
    const response = await fetchWithValidatedRedirects(
      robotsUrl,
      assertPublicWebsiteUrl,
      {},
      10_000,
    );
    const body = await response.text();
    return robotsParser(robotsUrl, body.slice(0, 500_000));
  } catch {
    return robotsParser(robotsUrl, "");
  }
}

export async function researchCompanyWebsite(companyId: string) {
  const company = getCompany(companyId);
  if (!company) throw notFound("Company not found.");
  let expectedCompany = websiteCompanyAnchor(company);
  const refreshCompanyAnchor = () => {
    const current = getCompany(companyId);
    if (!current) {
      throw conflict(
        "The company changed while website research was running. The stale result was discarded.",
        "stale_provider_result",
      );
    }
    expectedCompany = websiteCompanyAnchor(current);
    return current;
  };
  const rawUrl = company.websiteUrl || (company.domain ? `https://${company.domain}` : null);
  if (!rawUrl) throw conflict("Confirm a public company website first.");
  if (rawUrl.length > 2_048) {
    throw badRequest("The company website URL is too long to research safely.");
  }
  const baseUrl = new URL(rawUrl);
  await assertPublicWebsiteUrl(baseUrl);
  assertWebsiteCompanyUnchanged(companyId, expectedCompany);
  const robots = await robotsFor(baseUrl.origin);
  assertWebsiteCompanyUnchanged(companyId, expectedCompany);

  let pagesFetched = 0;
  let pagesSkipped = 0;
  let jobsFound = 0;
  let contactsFound = 0;
  let missionScopeFlagged = false;
  let crawlTruncated = false;
  let atsDiscoveryTruncated = false;
  const fetched = new Set<string>();
  const discoveredCareerLinks = new Set<string>();
  const discoveredSameOriginCareerLinks = new Set<string>();
  const successfullyFetchedUrls = new Set<string>();
  const encounteredHiringSurfaces = new Set<string>();
  const trustedHiringSurfaces = new Set<string>();
  const observedCompanyWebsiteJobIds = new Set<string>();
  const observedMailtoAddresses = new Set<string>();
  const discoveredBoards = new Map<string, SupportedBoard>();
  const pagePaths = [...likelyPaths];
  const settings = getSettings();
  const pageLimit = Math.min(
    MAX_CRAWL_PAGES,
    Math.max(1, Number(settings.companySitePageLimit) || 12),
  );
  const flagMissionScope = settings.excludeSocialJustice !== false;
  const addCareerLink = (url: string) => {
    if (
      !discoveredCareerLinks.has(url) &&
      discoveredCareerLinks.size >= MAX_DISCOVERED_CAREER_LINKS
    ) {
      crawlTruncated = true;
      return false;
    }
    discoveredCareerLinks.add(url);
    return true;
  };

  for (let index = 0; index < pagePaths.length && pagesFetched < pageLimit; index++) {
    assertWebsiteCompanyUnchanged(companyId, expectedCompany);
    const pageUrl = new URL(pagePaths[index], baseUrl.origin);
    const canonical = pageUrl.toString();
    if (fetched.has(canonical)) continue;
    fetched.add(canonical);
    if (robots.isAllowed(canonical, crawlerAgent) === false) {
      pagesSkipped++;
      continue;
    }
    let response: Response;
    try {
      response = await fetchWithValidatedRedirects(
        canonical,
        assertPublicWebsiteUrl,
        {},
        20_000,
      );
    } catch {
      assertWebsiteCompanyUnchanged(companyId, expectedCompany);
      pagesSkipped++;
      continue;
    }
    assertWebsiteCompanyUnchanged(companyId, expectedCompany);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      pagesSkipped++;
      continue;
    }
    const html = await response.text();
    assertWebsiteCompanyUnchanged(companyId, expectedCompany);
    if (html.length > 5_000_000) {
      pagesSkipped++;
      continue;
    }
    const $ = load(html);
    const title = truncate(cleanText($("title").first().text()), 1_000);
    const bodyText = cleanText($("body").text());
    const structuredJobs = parseStructuredJobsBounded(html);
    const hiringAssessment = assessHiringSurfaceContent(
      canonical,
      title,
      bodyText,
      html,
      structuredJobs.jobs.length,
    );
    if (hiringAssessment.candidate) {
      encounteredHiringSurfaces.add(canonical);
    }
    if (hiringAssessment.softBlocked) {
      pagesSkipped++;
      continue;
    }
    pagesFetched++;
    successfullyFetchedUrls.add(canonical);
    if (hiringAssessment.trustedForReconciliation) {
      trustedHiringSurfaces.add(canonical);
    }
    const snapshot = saveSnapshot(canonical, html);
    const description =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      "";
    const publicMissionText = cleanText(
      `${title} ${description} ${$("main").text() || bodyText}`,
    );
    if (
      flagMissionScope &&
      !missionScopeFlagged &&
      /\b(social justice|racial (?:equity|justice)|economic justice|environmental justice|gender justice|reproductive justice|criminal justice reform|anti[- ]racis(?:m|t)|intersectional justice)\b/i.test(
        publicMissionText,
      )
    ) {
      missionScopeFlagged = true;
      addEvidence({
        entityType: "company",
        entityId: companyId,
        fieldName: "mission_scope_review",
        value: "Public company mission may be outside the configured business scope",
        sourceType: "company_website",
        sourceLabel: "Company website mission statement",
        sourceUrl: canonical,
        excerpt: truncate(publicMissionText, 500),
        screenshotPath: snapshot.filePath,
        confidence: 0.85,
      });
      patchCompany(companyId, {
        fitConfirmed: false,
        status: "needs_research",
        reviewed: false,
      });
    }

    if (index === 0) {
      patchCompany(companyId, {
        websiteUrl: baseUrl.origin,
        domain: baseUrl.hostname.replace(/^www\./, ""),
        description: company.description || truncate(cleanText(description), 1_000),
      });
    }

    addEvidence({
      entityType: "company",
      entityId: companyId,
      fieldName: pageUrl.pathname === "/" ? "website" : "public_page",
      value: title || canonical,
      sourceType: "company_website",
      sourceLabel: "Company website",
      sourceUrl: canonical,
      excerpt: truncate(cleanText(description || $("body").text()), 500),
      screenshotPath: snapshot.filePath,
      confidence: 0.9,
      payload: { contentHash: snapshot.hash, contentType },
    });

    const boardCompany = getCompany(companyId);
    if (!boardCompany) {
      throw conflict(
        "The company changed while website research was running. The stale result was discarded.",
        "stale_provider_result",
      );
    }
    $("a[href]").each((anchorIndex, element) => {
      if (anchorIndex >= MAX_ANCHORS_PER_PAGE) {
        crawlTruncated = true;
        return false;
      }
      const href = $(element).attr("href");
      const label = truncate(cleanText($(element).text()), 500);
      if (!href) return;
      try {
        const target = new URL(href, canonical);
        if (target.toString().length > 2_048) {
          crawlTruncated = true;
          return;
        }
        const board = supportedBoard(target);
        if (board) {
          target.hash = "";
          const boardKey = `${board.provider}:${board.identifier.toLowerCase()}`;
          const detectedBoard: SupportedBoard = {
            ...board,
            url: target.toString(),
            discoveredOn: canonical,
            linkLabel: label,
            ownershipConfidence: boardOwnershipConfidence(
              boardCompany,
              board,
              canonical,
              label,
            ),
          };
          if (
            !discoveredBoards.has(boardKey) &&
            discoveredBoards.size >= MAX_DISCOVERED_BOARDS
          ) {
            crawlTruncated = true;
            atsDiscoveryTruncated = true;
          } else {
            const existing = discoveredBoards.get(boardKey);
            if (
              !existing ||
              detectedBoard.ownershipConfidence >
                existing.ownershipConfidence
            ) {
              discoveredBoards.set(boardKey, detectedBoard);
            }
          }
          addCareerLink(detectedBoard.url);
        }
        if (
          target.origin === baseUrl.origin &&
          /\b(career|jobs|join|team|leadership|contact)\b/i.test(
            `${target.pathname} ${label}`,
          )
        ) {
          target.hash = "";
          const targetUrl = target.toString();
          addCareerLink(targetUrl);
          if (/\b(career|jobs|join)\b/i.test(`${target.pathname} ${label}`)) {
            if (
              !discoveredSameOriginCareerLinks.has(targetUrl) &&
              discoveredSameOriginCareerLinks.size >=
                MAX_DISCOVERED_CAREER_LINKS
            ) {
              crawlTruncated = true;
            } else {
              discoveredSameOriginCareerLinks.add(targetUrl);
            }
          }
          if (!fetched.has(targetUrl) && pagePaths.length < MAX_CRAWL_PAGES) {
            pagePaths.push(`${target.pathname}${target.search}`);
          } else if (
            !fetched.has(targetUrl) &&
            !pagePaths.includes(`${target.pathname}${target.search}`)
          ) {
            crawlTruncated = true;
          }
        }
      } catch {
        // Ignore malformed links.
      }
    });

    const mailtoAddresses = new Set<string>();
    $("a[href^='mailto:']").each((_, element) => {
      const email = ($(element).attr("href") || "")
        .replace(/^mailto:/i, "")
        .split("?")[0]
        .trim()
        .toLowerCase();
      if (
        email.length > 320 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        mailtoAddresses.has(email) ||
        observedMailtoAddresses.has(email)
      ) {
        return;
      }
      if (
        mailtoAddresses.size >= MAX_MAILTO_ADDRESSES_PER_PAGE ||
        observedMailtoAddresses.size >= MAX_MAILTO_ADDRESSES_PER_CRAWL
      ) {
        crawlTruncated = true;
        return false;
      }
      mailtoAddresses.add(email);
      observedMailtoAddresses.add(email);
    });
    for (const email of mailtoAddresses) {
      const label = email.split("@")[0].replace(/[._-]+/g, " ");
      const contact = addContact(companyId, {
        fullName: label.replace(/\b\w/g, (letter) => letter.toUpperCase()),
        title: "Published company contact",
        roleCategory: "generic_contact",
        email,
        emailType: email.endsWith(`@${baseUrl.hostname.replace(/^www\./, "")}`)
          ? "generic"
          : "personal",
        emailStatus: "unverified",
        rank: 20,
        status: "alternate",
      });
      if (!contact) continue;
      contactsFound++;
      addEvidence({
        entityType: "contact",
        entityId: contact.id,
        fieldName: "email",
        value: email,
        sourceType: "company_website",
        sourceLabel: "Published on company website",
        sourceUrl: canonical,
        confidence: 0.85,
        payload: { contentHash: snapshot.hash },
      });
    }

    crawlTruncated ||= structuredJobs.truncated;
    for (const job of structuredJobs.jobs) {
      const titleValue = truncate(scalarSchemaValue(job.title) || "", 500);
      if (!titleValue) continue;
      const externalId = structuredJobExternalId(job, canonical);
      if (
        !observedCompanyWebsiteJobIds.has(externalId) &&
        observedCompanyWebsiteJobIds.size >= MAX_WEBSITE_JOB_IDS
      ) {
        crawlTruncated = true;
        break;
      }
      if (observedCompanyWebsiteJobIds.has(externalId)) continue;
      observedCompanyWebsiteJobIds.add(externalId);
      const rawJobUrl = scalarSchemaValue(job.url);
      let jobUrl = canonical;
      if (rawJobUrl) {
        try {
          const parsedJobUrl = new URL(rawJobUrl, canonical);
          if (["http:", "https:"].includes(parsedJobUrl.protocol)) {
            jobUrl = parsedJobUrl.toString();
          }
        } catch {
          // Keep the canonical page URL when JSON-LD supplies a malformed URL.
        }
      }
      const jobResult = upsertJob({
        companyId,
        externalId,
        title: titleValue,
        location: extractLocation(job.jobLocation),
        department: null,
        descriptionExcerpt: truncate(cleanText(String(job.description || "")), 700),
        url: jobUrl,
        sourceType: "company_website",
        postedAt: scalarSchemaValue(job.datePosted)?.slice(0, 64) || null,
      });
      if (jobResult.inserted) jobsFound++;
    }
    refreshCompanyAnchor();
  }

  assertWebsiteCompanyUnchanged(companyId, expectedCompany);
  for (const url of discoveredCareerLinks) {
    addEvidence({
      entityType: "company",
      entityId: companyId,
      fieldName: "careers_page",
      value: url,
      sourceType: "company_website",
      sourceLabel: "Company website",
      sourceUrl: url,
      confidence: 0.85,
    });
  }
  refreshCompanyAnchor();

  const completeCompanyWebsiteJobCrawl =
    !crawlTruncated &&
    pagesFetched > 0 &&
    trustedHiringSurfaces.size > 0 &&
    Array.from(encounteredHiringSurfaces).every((url) =>
      trustedHiringSurfaces.has(url),
    ) &&
    Array.from(discoveredSameOriginCareerLinks).every((url) =>
      successfullyFetchedUrls.has(url) && trustedHiringSurfaces.has(url),
    );
  const companyWebsiteJobsReconciled = reconcileCompanyWebsiteJobs(
    companyId,
    observedCompanyWebsiteJobIds,
    completeCompanyWebsiteJobCrawl,
    crawlTruncated,
  );
  refreshCompanyAnchor();

  const activeJobIdsBefore = new Set(
    getCompany(companyId)?.jobs.filter((job) => job.active).map((job) => job.id) ||
      [],
  );
  let boardsIngested = 0;
  let atsBoardsAttempted = 0;
  let atsJobsObserved = 0;
  let atsBudgetTruncated = atsDiscoveryTruncated;
  for (const board of discoveredBoards.values()) {
    assertWebsiteCompanyUnchanged(companyId, expectedCompany);
    const recordBoardCandidate = (excerpt: string) => {
      addEvidence({
        entityType: "company",
        entityId: companyId,
        fieldName: "job_board_candidate",
        value: `${board.provider}:${board.identifier}`,
        sourceType: "company_website",
        sourceLabel: "Detected public job-board link",
        sourceUrl: board.url,
        excerpt,
        confidence: board.ownershipConfidence,
        payload: {
          discoveredOn: board.discoveredOn,
          linkLabel: board.linkLabel,
          ownershipConfidence: board.ownershipConfidence,
        },
      });
    };
    if (
      board.ownershipConfidence < MIN_ATS_OWNERSHIP_CONFIDENCE
    ) {
      recordBoardCandidate(
        "Detected, but the link context and board identifier do not establish confident company ownership. Review manually.",
      );
      refreshCompanyAnchor();
      continue;
    }
    if (
      atsBoardsAttempted >= MAX_ATS_BOARDS_PER_CRAWL ||
      atsJobsObserved >= MAX_ATS_JOBS_PER_CRAWL
    ) {
      atsBudgetTruncated = true;
      recordBoardCandidate(
        "Detected, but deferred because this website crawl reached its ATS board or job budget.",
      );
      refreshCompanyAnchor();
      continue;
    }
    let boardError: unknown;
    let observedOnBoard = 0;
    const ingestOptions = {
      maxJobs: MAX_ATS_JOBS_PER_CRAWL - atsJobsObserved,
      ownership: {
        confidence: board.ownershipConfidence,
        sourceUrl: board.discoveredOn,
      },
      expectedCompany: { ...expectedCompany },
    };
    atsBoardsAttempted++;
    try {
      let result;
      if (board.provider === "greenhouse") {
        result = await ingestGreenhouse(
          board.identifier,
          companyId,
          ingestOptions,
        );
      } else if (board.provider === "lever") {
        result = await ingestLever(board.identifier, companyId, ingestOptions);
      } else {
        result = await ingestAshby(board.identifier, companyId, ingestOptions);
      }
      observedOnBoard = result.jobsObserved;
      boardsIngested++;
    } catch (error) {
      boardError = error;
    }
    assertWebsiteCompanyUnchanged(companyId, expectedCompany, false);
    if (boardError) {
      if (
        boardError instanceof Error &&
        String((boardError as { code?: unknown }).code || "") ===
          "stale_provider_result"
      ) {
        throw boardError;
      }
      if (
        boardError instanceof Error &&
        String((boardError as { code?: unknown }).code || "") ===
          "job_board_budget_exceeded"
      ) {
        atsBudgetTruncated = true;
      }
      recordBoardCandidate(
        boardError instanceof Error
          ? `Detected but could not refresh: ${truncate(boardError.message, 300)}`
          : "Detected but could not refresh.",
      );
    } else {
      atsJobsObserved += observedOnBoard;
    }
    refreshCompanyAnchor();
  }
  const activeJobsAfter =
    getCompany(companyId)?.jobs.filter((job) => job.active) || [];
  jobsFound += activeJobsAfter.filter((job) => !activeJobIdsBefore.has(job.id)).length;
  if (pagesFetched > 0) {
    assertWebsiteCompanyUnchanged(companyId, expectedCompany);
    patchCompany(companyId, { lastResearchedAt: new Date().toISOString() });
    refreshCompanyAnchor();
  }

  return {
    pagesFetched,
    pagesSkipped,
    jobsFound,
    contactsFound,
    missionScopeFlagged,
    careerLinks: Array.from(discoveredCareerLinks),
    boardsIngested,
    completeCompanyWebsiteJobCrawl,
    companyWebsiteJobsReconciled,
    crawlTruncated,
    atsBudgetTruncated,
    atsBoardsAttempted,
    atsJobsObserved,
  };
}
