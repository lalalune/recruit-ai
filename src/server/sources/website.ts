import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { load } from "cheerio";
import robotsParser from "robots-parser";
import {
  addContact,
  addEvidence,
  getCompany,
  getSettings,
  patchCompany,
  upsertJob,
} from "../repository";
import { getSnapshotsDir } from "../paths";
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
};

function supportedBoard(url: URL): SupportedBoard | null {
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
    throw new Error("Only public HTTP and HTTPS pages can be researched.");
  }
  if (url.username || url.password) {
    throw new Error("Website URLs cannot contain credentials.");
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
    throw new Error("Local network addresses cannot be researched.");
  }
  if (literalFamily) {
    if (isBlockedNetworkAddress(hostname)) {
      throw new Error("Private or non-public network addresses are blocked.");
    }
    return [{ address: hostname, family: literalFamily as 4 | 6 }];
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some((entry) => isBlockedNetworkAddress(entry.address))
  ) {
    throw new Error("The domain resolved to a private, non-public, or unavailable address.");
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

function findJobPostings(value: unknown): Record<string, unknown>[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(findJobPostings);
  if (typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const type = object["@type"];
  const types = Array.isArray(type) ? type : [type];
  const own = types.includes("JobPosting") ? [object] : [];
  return [
    ...own,
    ...Object.values(object).flatMap((child) =>
      child === value ? [] : findJobPostings(child),
    ),
  ];
}

function parseStructuredJobs(html: string) {
  const $ = load(html);
  const jobs: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).text();
    try {
      jobs.push(...findJobPostings(JSON.parse(raw)));
    } catch {
      // Malformed JSON-LD is common and should not stop the rest of the page.
    }
  });
  return jobs;
}

function extractLocation(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  const address = object.address as Record<string, unknown> | undefined;
  if (!address) return null;
  return [address.addressLocality, address.addressRegion, address.addressCountry]
    .filter(Boolean)
    .join(", ");
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
    return robotsParser(robotsUrl, await response.text());
  } catch {
    return robotsParser(robotsUrl, "");
  }
}

export async function researchCompanyWebsite(companyId: string) {
  const company = getCompany(companyId);
  if (!company) throw new Error("Company not found.");
  const rawUrl = company.websiteUrl || (company.domain ? `https://${company.domain}` : null);
  if (!rawUrl) throw new Error("Confirm a public company website first.");
  const baseUrl = new URL(rawUrl);
  await assertPublicWebsiteUrl(baseUrl);
  const robots = await robotsFor(baseUrl.origin);

  let pagesFetched = 0;
  let pagesSkipped = 0;
  let jobsFound = 0;
  let contactsFound = 0;
  let missionScopeFlagged = false;
  const fetched = new Set<string>();
  const discoveredCareerLinks = new Set<string>();
  const discoveredBoards = new Map<string, SupportedBoard>();
  const pagePaths = [...likelyPaths];
  const settings = getSettings();
  const pageLimit = Math.min(
    20,
    Math.max(1, Number(settings.companySitePageLimit) || 12),
  );
  const flagMissionScope = settings.excludeSocialJustice !== false;

  for (let index = 0; index < pagePaths.length && pagesFetched < pageLimit; index++) {
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
      pagesSkipped++;
      continue;
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      pagesSkipped++;
      continue;
    }
    const html = await response.text();
    if (html.length > 5_000_000) {
      pagesSkipped++;
      continue;
    }
    pagesFetched++;
    const snapshot = saveSnapshot(canonical, html);
    const $ = load(html);
    const title = cleanText($("title").first().text());
    const description =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      "";
    const publicMissionText = cleanText(
      `${title} ${description} ${$("main").text() || $("body").text()}`,
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

    $("a[href]").each((_, element) => {
      const href = $(element).attr("href");
      const label = cleanText($(element).text());
      if (!href) return;
      try {
        const target = new URL(href, canonical);
        const board = supportedBoard(target);
        if (board) {
          discoveredBoards.set(
            `${board.provider}:${board.identifier.toLowerCase()}`,
            board,
          );
          discoveredCareerLinks.add(board.url);
        }
        if (
          target.origin === baseUrl.origin &&
          /\b(career|jobs|join|team|leadership|contact)\b/i.test(
            `${target.pathname} ${label}`,
          )
        ) {
          discoveredCareerLinks.add(target.toString());
          if (!fetched.has(target.toString()) && pagePaths.length < 20) {
            pagePaths.push(target.pathname);
          }
        }
      } catch {
        // Ignore malformed links.
      }
    });

    const mailtoAddresses = $("a[href^='mailto:']")
      .map((_, element) =>
        ($(element).attr("href") || "")
          .replace(/^mailto:/i, "")
          .split("?")[0]
          .trim()
          .toLowerCase(),
      )
      .get()
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    for (const email of new Set(mailtoAddresses)) {
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

    for (const job of parseStructuredJobs(html)) {
      const titleValue = String(job.title || "").trim();
      if (!titleValue) continue;
      const jobResult = upsertJob({
        companyId,
        externalId: String(job.identifier || job.url || `${titleValue}:${canonical}`),
        title: titleValue,
        location: extractLocation(job.jobLocation),
        department: null,
        descriptionExcerpt: truncate(cleanText(String(job.description || "")), 700),
        url: job.url ? String(job.url) : canonical,
        sourceType: "company_website",
        postedAt: job.datePosted ? String(job.datePosted) : null,
      });
      if (jobResult.inserted) jobsFound++;
    }
  }

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

  const activeJobIdsBefore = new Set(
    getCompany(companyId)?.jobs.filter((job) => job.active).map((job) => job.id) ||
      [],
  );
  let boardsIngested = 0;
  for (const board of discoveredBoards.values()) {
    try {
      if (board.provider === "greenhouse") {
        await ingestGreenhouse(board.identifier, companyId);
      } else if (board.provider === "lever") {
        await ingestLever(board.identifier, companyId);
      } else {
        await ingestAshby(board.identifier, companyId);
      }
      boardsIngested++;
    } catch (error) {
      addEvidence({
        entityType: "company",
        entityId: companyId,
        fieldName: "job_board_candidate",
        value: `${board.provider}:${board.identifier}`,
        sourceType: "company_website",
        sourceLabel: "Detected public job-board link",
        sourceUrl: board.url,
        excerpt:
          error instanceof Error
            ? `Detected but could not refresh: ${truncate(error.message, 300)}`
            : "Detected but could not refresh.",
        confidence: 0.75,
      });
    }
  }
  const activeJobsAfter =
    getCompany(companyId)?.jobs.filter((job) => job.active) || [];
  jobsFound += activeJobsAfter.filter((job) => !activeJobIdsBefore.has(job.id)).length;
  if (pagesFetched > 0) {
    patchCompany(companyId, { lastResearchedAt: new Date().toISOString() });
  }

  return {
    pagesFetched,
    pagesSkipped,
    jobsFound,
    contactsFound,
    missionScopeFlagged,
    careerLinks: Array.from(discoveredCareerLinks),
    boardsIngested,
  };
}
