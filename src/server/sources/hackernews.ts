import { load } from "cheerio";
import {
  addEvidence,
  isBayAreaLocation,
  upsertCompany,
  upsertJob,
} from "../repository";
import { normalizeDomain } from "../database";
import { cleanText, fetchWithTimeout, mapWithConcurrency, truncate } from "./http";

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

function extractExternalUrl(html: string) {
  const $ = load(html);
  const hrefs = $("a[href]")
    .map((_, element) => $(element).attr("href"))
    .get()
    .filter((href): href is string => Boolean(href));
  for (const href of hrefs) {
    try {
      const url = new URL(href);
      if (
        !url.hostname.endsWith("ycombinator.com") &&
        !url.hostname.endsWith("linkedin.com") &&
        !url.hostname.endsWith("github.com")
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
    role: likelyRole || "Hiring via Hacker News",
    text,
  };
}

async function getItem(id: number) {
  const response = await fetchWithTimeout(
    `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
  );
  return (await response.json()) as HnItem | null;
}

export async function discoverHackerNews(limit: number) {
  const askResponse = await fetchWithTimeout(
    "https://hacker-news.firebaseio.com/v0/askstories.json",
  );
  const askIds = ((await askResponse.json()) as number[]).slice(0, 500);
  const askItems = await mapWithConcurrency(askIds, 12, (id) => getItem(id));
  const thread = askItems
    .filter(
      (item): item is HnItem =>
        Boolean(item?.title && /^Ask HN: Who is hiring\?/i.test(item.title)),
    )
    .sort((a, b) => (b.time || 0) - (a.time || 0))[0];
  if (!thread) {
    throw new Error("Could not find a recent Hacker News Who Is Hiring thread.");
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
