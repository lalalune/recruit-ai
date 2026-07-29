import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import type { LookupFunction } from "node:net";
import { upstreamFailure } from "../errors";

const USER_AGENT =
  "RecruitAIResearch/0.1 (+local owner-operated research; contact via application settings)";

function requestHeaders(init: RequestInit) {
  const headers = new Headers({
    Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
    "User-Agent": USER_AGENT,
  });
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
) {
  return fetchRetried(url, init, timeoutMs, true);
}

export async function fetchProviderResponse(
  provider: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
) {
  const safeProvider = provider.replace(/[^\w .-]/g, "").slice(0, 80) || "Provider";
  try {
    return await fetchRetried(url, init, timeoutMs, false);
  } catch {
    throw upstreamFailure(
      `${safeProvider} could not be reached. Try again later.`,
      "provider_unavailable",
    );
  }
}

async function fetchRetried(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  throwOnHttpError: boolean,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      ...init,
      headers: requestHeaders(init),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const retryable =
      response.status === 429 || (response.status >= 500 && response.status <= 599);
    if (response.ok || !retryable || attempt === 2) {
      if (!response.ok && throwOnHttpError) {
        throw new Error(
          `${response.status} ${response.statusText} from ${new URL(url).hostname}`,
        );
      }
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(10_000, retryAfter * 1_000)
      : 400 * 2 ** attempt + Math.floor(Math.random() * 200);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`Request failed after retries to ${new URL(url).hostname}`);
}

type RuntimeSchema<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error?: unknown };
};

export async function readBoundedJson<T>(
  response: Response,
  provider: string,
  schema: RuntimeSchema<T>,
  maxBytes = 1_000_000,
) {
  const safeProvider = provider.replace(/[^\w .-]/g, "").slice(0, 80) || "Provider";
  const boundedLimit = Math.min(10_000_000, Math.max(1_024, maxBytes));
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > boundedLimit) {
    await response.body?.cancel().catch(() => undefined);
    throw upstreamFailure(
      `${safeProvider} returned more data than this request allows.`,
      "upstream_payload_too_large",
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw upstreamFailure(
      `${safeProvider} returned an empty or malformed response.`,
      "upstream_payload_invalid",
    );
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > boundedLimit) {
        await reader.cancel().catch(() => undefined);
        throw upstreamFailure(
          `${safeProvider} returned more data than this request allows.`,
          "upstream_payload_too_large",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      ["upstream_payload_too_large", "upstream_payload_invalid"].includes(
        String((error as { code?: unknown }).code || ""),
      )
    ) {
      throw error;
    }
    throw upstreamFailure(
      `${safeProvider} returned an unreadable response.`,
      "upstream_payload_invalid",
    );
  }

  let decoded: unknown;
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw upstreamFailure(
      `${safeProvider} returned malformed JSON.`,
      "upstream_payload_invalid",
    );
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw upstreamFailure(
      `${safeProvider} returned data in an unexpected format.`,
      "upstream_payload_invalid",
    );
  }
  return parsed.data;
}

export async function fetchWithValidatedRedirects(
  url: string,
  validate: (
    url: URL,
  ) => Promise<Array<{ address: string; family: 4 | 6 }>>,
  init: RequestInit = {},
  timeoutMs = 20_000,
) {
  let current = new URL(url);
  for (let redirect = 0; redirect <= 5; redirect++) {
    const addresses = await validate(current);
    const response = await requestPinned(
      current,
      addresses,
      init,
      timeoutMs,
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect without a location from ${current.hostname}`);
      }
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `${response.status} ${response.statusText} from ${current.hostname}`,
      );
    }
    return response;
  }
  throw new Error(`Too many redirects from ${new URL(url).hostname}`);
}

function requestPinned(
  url: URL,
  addresses: Array<{ address: string; family: 4 | 6 }>,
  init: RequestInit,
  timeoutMs: number,
) {
  if (!addresses.length) {
    throw new Error(`No validated address is available for ${url.hostname}`);
  }
  if (init.body) {
    throw new Error("Validated public-page requests do not accept a request body.");
  }
  const selected = addresses[0];
  const lookup = ((
    _hostname: string,
    options: { all?: boolean },
    callback: (
      error: NodeJS.ErrnoException | null,
      address:
        | string
        | Array<{ address: string; family: 4 | 6 }>,
      family?: number,
    ) => void,
  ) => {
    if (options?.all) {
      callback(null, addresses);
    } else {
      callback(null, selected.address, selected.family);
    }
  }) as unknown as LookupFunction;
  const headers: Record<string, string> = {};
  requestHeaders(init).forEach((value, key) => {
    headers[key] = value;
  });
  return new Promise<Response>((resolve, reject) => {
    const request =
      url.protocol === "https:" ? requestHttps : requestHttp;
    const outgoing = request(
      url,
      {
        method: init.method || "GET",
        headers,
        lookup,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 5_000_000) {
            incoming.destroy(
              new Error(`Response exceeded the 5 MB limit from ${url.hostname}`),
            );
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(key, item);
            } else if (value !== undefined) {
              responseHeaders.set(key, String(value));
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode || 500,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        output[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

export function cleanText(value?: string | null) {
  return (value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(value: string, length = 500) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
