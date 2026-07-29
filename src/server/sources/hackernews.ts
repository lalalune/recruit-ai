import { load } from "cheerio";
import {
  addEvidence,
  isBayAreaLocation,
  upsertCompany,
  upsertJob,
} from "../repository";
import { normalizeDomain } from "../database";
import { z } from "zod";
import { upstreamFailure } from "../errors";
import {
  cleanText,
  fetchProviderResponse,
  mapWithConcurrency,
  readBoundedJson,
  truncate,
} from "./http";

interface HnItem {
  id: number;
  type: string;
  title?: string;
  text?: string;
  by?: string;
  time?: number;
  kids?: number[];
  dead?: boolean;
  deleted?: boolean;
}

const HnItemSchema = z
  .object({
    id: z.number().int().nonnegative(),
    type: z.string().max(100).optional().default("unknown"),
    title: z.string().max(2_000).optional(),
    text: z.string().max(2_000_000).optional(),
    by: z.string().max(500).optional(),
    time: z.number().int().nonnegative().optional(),
    kids: z.array(z.number().int().nonnegative()).max(5_000).optional(),
    dead: z.boolean().optional(),
    deleted: z.boolean().optional(),
  })
  .nullable();
const HnIdListSchema = z.array(z.number().int().nonnegative()).max(2_000);

function extractExternalUrl(html: string) {
  const $ = load(html);
  const hrefs = $("a[href]")
    .map((_, element) => $(element).attr("href"))
    .get()
    .filter((href): href is string => Boolean(href));
  for (const href of hrefs) {
    try {
      if (href.length > 2_048) continue;
      const url = new URL(href);
      const isHost = (domain: string) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        !isHost("ycombinator.com") &&
        !isHost("linkedin.com") &&
        !isHost("github.com")
      ) {
        return url.toString();
      }
    } catch {
      continue;
    }
  }
  return null;
}

function parseComment(comment: HnItem) {
  const html = comment.text || "";
  const text = cleanText(html);
  if (!text || !isBayAreaLocation(text)) return null;
  const firstLine = cleanText(html.split(/<p>|<br\s*\/?>/i)[0]);
  const segments = firstLine
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const companyName = segments[0]?.replace(/\s+\(.*?\)\s*$/, "").trim();
  if (!companyName || companyName.length > 120) return null;
  if (/\b(recruiting|staffing|agency|headhunter)\b/i.test(companyName)) return null;
  const externalUrl = extractExternalUrl(html);
  const domain = normalizeDomain(externalUrl);
  const likelyRole = segments
    .slice(1)
    .find(
      (segment) =>
        !isBayAreaLocation(segment) &&
        !/\b(remote|onsite|hybrid|full.?time|part.?time)\b/i.test(segment),
    );
  return {
    companyName,
    externalUrl,
    domain,
    role: truncate(likelyRole || "Hiring via Hacker News", 500),
    text,
  };
}

async function getItem(id: number) {
  const response = await fetchProviderResponse(
    "Hacker News",
    `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw upstreamFailure(
      `Hacker News rejected an item request (HTTP ${response.status}).`,
      "hackernews_request_rejected",
    );
  }
  return readBoundedJson(
    response,
    "Hacker News",
    HnItemSchema,
    2_500_000,
  ) as Promise<HnItem | null>;
}

export async function discoverHackerNews(limit: number) {
  const askResponse = await fetchProviderResponse(
    "Hacker News",
    "https://hacker-news.firebaseio.com/v0/askstories.json",
  );
  if (!askResponse.ok) {
    await askResponse.body?.cancel().catch(() => undefined);
    throw upstreamFailure(
      `Hacker News rejected the story-list request (HTTP ${askResponse.status}).`,
      "hackernews_request_rejected",
    );
  }
  const askIds = (
    await readBoundedJson(
      askResponse,
      "Hacker News",
      HnIdListSchema,
      100_000,
    )
  ).slice(0, 500);
  const askItems = await mapWithConcurrency(askIds, 12, (id) => getItem(id));
  const thread = askItems
    .filter(
      (item): item is HnItem =>
        Boolean(item?.title && /^Ask HN: Who is hiring\?/i.test(item.title)),
    )
    .sort((a, b) => (b.time || 0) - (a.time || 0))[0];
  if (!thread) {
    throw upstreamFailure(
      "Could not find a recent Hacker News Who Is Hiring thread.",
      "hackernews_thread_not_found",
    );
  }
  const commentIds = (thread.kids || []).slice(0, 500);
  const comments = await mapWithConcurrency(commentIds, 16, (id) => getItem(id));
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const comment of comments) {
    if (inserted + updated >= limit) break;
    if (!comment || comment.dead || comment.deleted) {
      skipped++;
      continue;
    }
    const parsed = parseComment(comment);
    if (!parsed) {
      skipped++;
      continue;
    }
    const company = upsertCompany({
      name: parsed.companyName,
      domain: parsed.domain,
      websiteUrl: parsed.externalUrl,
      location: "San Francisco Bay Area",
      industries: ["Technology"],
      status: "ready_for_review",
      priority: "high",
    });
    if (company.inserted) inserted++;
    else updated++;
    const sourceUrl = `https://news.ycombinator.com/item?id=${comment.id}`;
    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "hiring_signal",
      value: parsed.role,
      sourceType: "hackernews",
      sourceLabel: "Hacker News Who Is Hiring",
      sourceUrl,
      excerpt: truncate(parsed.text, 700),
      confidence: 0.8,
      payload: { threadId: thread.id, commentId: comment.id },
    });
    upsertJob({
      companyId: company.id,
      externalId: String(comment.id),
      title: parsed.role,
      location: "San Francisco Bay Area",
      descriptionExcerpt: truncate(parsed.text, 700),
      url: sourceUrl,
      sourceType: "hackernews",
      postedAt: comment.time ? new Date(comment.time * 1000).toISOString() : null,
    });
  }
  return { inserted, updated, skipped };
}
