import { normalizeName } from "../database";
import {
  addEvidence,
  getCompany,
  listCompaniesMissingDomain,
  patchCompany,
} from "../repository";
import { getSecret } from "../secrets";
import { fetchWithTimeout, mapWithConcurrency } from "./http";

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

const excludedHosts = [
  "linkedin.com",
  "crunchbase.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "github.com",
  "ycombinator.com",
  "bloomberg.com",
  "pitchbook.com",
  "zoominfo.com",
  "rocketreach.co",
  "glassdoor.com",
  "indeed.com",
  "opencorporates.com",
  "bizapedia.com",
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
];

function blockedHost(hostname: string) {
  const host = hostname.replace(/^www\./, "").toLowerCase();
  return excludedHosts.some((value) => host === value || host.endsWith(`.${value}`));
}

function scoreResult(companyName: string, result: BraveResult) {
  if (!result.url) return null;
  let url: URL;
  try {
    url = new URL(result.url);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || blockedHost(url.hostname)) {
    return null;
  }
  const normalizedCompany = normalizeName(companyName);
  const compactCompany = normalizedCompany.replace(/\s+/g, "");
  const normalizedTitle = normalizeName(result.title || "");
  const hostLabel = url.hostname
    .replace(/^www\./, "")
    .split(".")[0]
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  let score = 0;
  if (normalizedTitle === normalizedCompany) score += 55;
  else if (normalizedTitle.includes(normalizedCompany)) score += 42;
  else {
    const matchedTokens = normalizedCompany
      .split(" ")
      .filter((token) => token.length > 2 && normalizedTitle.includes(token));
    score += Math.min(30, matchedTokens.length * 10);
  }
  if (hostLabel === compactCompany) score += 40;
  else if (
    compactCompany.length >= 5 &&
    (hostLabel.includes(compactCompany) || compactCompany.includes(hostLabel))
  ) {
    score += 30;
  }
  if (url.pathname === "/" || url.pathname === "") score += 5;
  if (
    /\b(san francisco|sf bay|bay area|oakland|berkeley|palo alto|san jose)\b/i.test(
      result.description || "",
    )
  ) {
    score += 8;
  }
  return {
    title: result.title || url.hostname,
    url: url.toString(),
    domain: url.hostname.replace(/^www\./, "").toLowerCase(),
    description: result.description || "",
    score: Math.min(100, score),
  };
}

export async function resolveCompanyDomainWithBrave(
  companyId: string,
  autoApplyHighConfidence = false,
) {
  const key = getSecret("BRAVE_SEARCH_API_KEY");
  if (!key) {
    throw new Error("Brave Search is not configured. Add an API key in Settings.");
  }
  const company = getCompany(companyId);
  if (!company) throw new Error("Company not found.");
  const query = new URLSearchParams({
    q: `"${company.name}" ${company.location || "San Francisco Bay Area"} official website`,
    count: "10",
    safesearch: "moderate",
    search_lang: "en",
  });
  const response = await fetchWithTimeout(
    `https://api.search.brave.com/res/v1/web/search?${query}`,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": key,
      },
    },
    30_000,
  );
  const payload = (await response.json()) as {
    web?: { results?: BraveResult[] };
  };
  const candidates = (payload.web?.results || [])
    .map((result) => scoreResult(company.name, result))
    .filter((result): result is NonNullable<typeof result> => Boolean(result))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  for (const candidate of candidates) {
    addEvidence({
      entityType: "company",
      entityId: companyId,
      fieldName: "domain_candidate",
      value: candidate.domain,
      sourceType: "brave_search",
      sourceLabel: "Brave Search result",
      sourceUrl: candidate.url,
      excerpt: candidate.description,
      confidence: Math.max(0.4, candidate.score / 100),
      payload: candidate,
    });
  }
  const best = candidates[0];
  const lead = best ? best.score - (candidates[1]?.score || 0) : 0;
  const applied = Boolean(
    autoApplyHighConfidence && best && best.score >= 92 && lead >= 15,
  );
  if (applied && best) {
    patchCompany(companyId, {
      domain: best.domain,
      websiteUrl: best.url,
      lastResearchedAt: new Date().toISOString(),
    });
    addEvidence({
      entityType: "company",
      entityId: companyId,
      fieldName: "domain",
      value: best.domain,
      sourceType: "brave_search",
      sourceLabel: "High-confidence Brave Search match",
      sourceUrl: best.url,
      excerpt: best.description,
      confidence: best.score / 100,
      payload: { score: best.score, lead },
    });
  }
  return { candidates, applied };
}

export async function resolveMissingDomains(
  limit: number,
  autoApplyHighConfidence: boolean,
) {
  if (!getSecret("BRAVE_SEARCH_API_KEY")) {
    throw new Error("Brave Search is not configured. Add an API key in Settings.");
  }
  const ids = listCompaniesMissingDomain(limit);
  const results = await mapWithConcurrency(ids, 3, async (id) => {
    try {
      return await resolveCompanyDomainWithBrave(id, autoApplyHighConfidence);
    } catch {
      return null;
    }
  });
  const updated = results.filter((result) => result?.applied).length;
  const candidates = results.filter(
    (result) => result && result.candidates.length > 0 && !result.applied,
  ).length;
  return {
    inserted: 0,
    updated,
    skipped: ids.length - updated,
    candidates,
  };
}
