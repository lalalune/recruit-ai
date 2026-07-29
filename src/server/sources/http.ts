import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import type { LookupFunction } from "node:net";

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
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      ...init,
      headers: requestHeaders(init),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const retryable =
      response.status === 429 || (response.status >= 500 && response.status <= 599);
    if (response.ok || !retryable || attempt === 2) {
      if (!response.ok) {
        throw new Error(
          `${response.status} ${response.statusText} from ${new URL(url).hostname}`,
        );
      }
      return response;
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(10_000, retryAfter * 1_000)
      : 400 * 2 ** attempt + Math.floor(Math.random() * 200);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`Request failed after retries to ${new URL(url).hostname}`);
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
