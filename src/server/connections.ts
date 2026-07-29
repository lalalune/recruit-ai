import { getSecret, type SecretKey } from "./secrets";
import { z } from "zod";
import { conflict, upstreamFailure } from "./errors";
import { readBoundedJson } from "./sources/http";

export type TestableProvider =
  | "apollo"
  | "hunter"
  | "zerobounce"
  | "socrata"
  | "brave";

function requireSecret(key: SecretKey) {
  const value = getSecret(key);
  if (!value) {
    throw conflict(
      "Save this provider credential before testing it.",
      "provider_not_configured",
    );
  }
  return value;
}

async function checkedFetch(
  provider: string,
  url: string,
  init: RequestInit = {},
) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw upstreamFailure(
      `${provider} could not be reached. Check the network and try again.`,
      "provider_unavailable",
    );
  }
  if (!response.ok) {
    const reason =
      response.status === 401
        ? "credential was rejected"
        : response.status === 403
          ? "credential lacks the required plan or scope"
          : response.status === 429
            ? "rate limit was reached"
            : `returned HTTP ${response.status}`;
    throw upstreamFailure(`${provider} ${reason}.`, "provider_test_rejected");
  }
  return response;
}

export async function testProviderConnection(provider: TestableProvider) {
  if (provider === "apollo") {
    const response = await checkedFetch(
      "Apollo",
      "https://api.apollo.io/api/v1/auth/health",
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "x-api-key": requireSecret("APOLLO_API_KEY"),
        },
      },
    );
    const payload = await readBoundedJson(
      response,
      "Apollo",
      z.object({
        healthy: z.boolean().optional(),
        is_logged_in: z.boolean().optional(),
      }),
      250_000,
    );
    if (!payload.healthy || !payload.is_logged_in) {
      throw upstreamFailure(
        "Apollo responded, but the API key is not logged in.",
        "provider_test_rejected",
      );
    }
    return { provider, ok: true, detail: "API key authenticated; no credits used." };
  }

  if (provider === "hunter") {
    const response = await checkedFetch(
      "Hunter",
      "https://api.hunter.io/v2/account",
      {
        headers: {
          Authorization: `Bearer ${requireSecret("HUNTER_API_KEY")}`,
          Accept: "application/json",
        },
      },
    );
    const payload = await readBoundedJson(
      response,
      "Hunter",
      z.object({
        data: z
          .object({
            plan_name: z.string().max(200).optional(),
            requests: z
              .object({
                credits: z
                  .object({
                    available: z.number().min(0).max(1_000_000_000).optional(),
                  })
                  .optional(),
              })
              .optional(),
          })
          .optional(),
      }),
      250_000,
    );
    return {
      provider,
      ok: true,
      detail: `${payload.data?.plan_name || "Hunter"} account authenticated${
        payload.data?.requests?.credits?.available === undefined
          ? ""
          : ` · ${payload.data.requests.credits.available} credits available`
      }.`,
    };
  }

  if (provider === "zerobounce") {
    const query = new URLSearchParams({
      api_key: requireSecret("ZEROBOUNCE_API_KEY"),
    });
    const response = await checkedFetch(
      "ZeroBounce",
      `https://api.zerobounce.net/v2/getcredits?${query}`,
    );
    const payload = await readBoundedJson(
      response,
      "ZeroBounce",
      z.object({
        Credits: z.number().min(0).max(1_000_000_000).optional(),
        credits: z.number().min(0).max(1_000_000_000).optional(),
      }),
      100_000,
    );
    const credits = payload.Credits ?? payload.credits;
    return {
      provider,
      ok: true,
      detail:
        credits === undefined
          ? "Credential authenticated."
          : `${credits} verification credits available.`,
    };
  }

  if (provider === "socrata") {
    await checkedFetch(
      "DataSF",
      "https://data.sfgov.org/resource/g8m3-pdis.json?$limit=1",
      {
        headers: { "X-App-Token": requireSecret("SOCRATA_APP_TOKEN") },
      },
    );
    return { provider, ok: true, detail: "DataSF app token accepted." };
  }

  await checkedFetch(
    "Brave Search",
    "https://api.search.brave.com/res/v1/web/search?q=RecruitAI+connection+test&count=1",
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": requireSecret("BRAVE_SEARCH_API_KEY"),
      },
    },
  );
  return {
    provider,
    ok: true,
    detail: "Search API authenticated; the test used one query.",
  };
}
