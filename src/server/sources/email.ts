import {
  addEvidence,
  addSuppression,
  getCompany,
  getContact,
  patchContact,
} from "../repository";
import { getSecret } from "../secrets";
import { fetchWithTimeout } from "./http";

type InternalEmailStatus =
  | "valid"
  | "invalid"
  | "accept_all"
  | "unknown"
  | "disposable"
  | "do_not_mail"
  | "unverified";

function hunterKey() {
  const key = getSecret("HUNTER_API_KEY");
  if (!key) throw new Error("Hunter is not configured. Add an API key in Settings.");
  return key;
}

function mapHunterStatus(status?: string): InternalEmailStatus {
  switch (status) {
    case "valid":
      return "valid";
    case "invalid":
      return "invalid";
    case "accept_all":
      return "accept_all";
    case "disposable":
      return "disposable";
    case "unknown":
    case "webmail":
      return "unknown";
    default:
      return "unverified";
  }
}

export async function verifyEmailWithHunter(contactId: string) {
  const contact = getContact(contactId);
  if (!contact) throw new Error("Contact not found.");
  if (!contact.email) throw new Error("Add an email before verification.");
  const query = new URLSearchParams({
    email: contact.email,
  });
  const response = await fetchWithTimeout(
    `https://api.hunter.io/v2/email-verifier?${query}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${hunterKey()}`,
      },
    },
    30_000,
  );
  const payload = (await response.json()) as {
    data?: {
      status?: string;
      score?: number;
      sources?: Array<{ uri?: string; last_seen_on?: string }>;
    };
    errors?: Array<{ id?: string; details?: string }>;
  };
  if (payload.errors?.some((error) => error.id === "claimed_email")) {
    addSuppression(
      contact.email,
      "email",
      "Hunter reports that the address owner requested no processing.",
    );
    patchContact(contactId, {
      emailStatus: "do_not_mail",
      emailVerifiedAt: new Date().toISOString(),
    });
    throw new Error("The email owner has requested that this address not be processed.");
  }
  const status = mapHunterStatus(payload.data?.status);
  const verifiedAt = new Date().toISOString();
  const updated = patchContact(contactId, {
    emailStatus: status,
    emailVerifiedAt: verifiedAt,
  });
  addEvidence({
    entityType: "contact",
    entityId: contactId,
    fieldName: "email_verification",
    value: `${contact.email}: ${status}`,
    sourceType: "hunter",
    sourceLabel: "Hunter Email Verifier",
    sourceUrl: payload.data?.sources?.[0]?.uri || null,
    excerpt: `Hunter status ${payload.data?.status || "unknown"}, score ${payload.data?.score ?? "n/a"}`,
    confidence: status === "valid" ? 0.9 : status === "invalid" ? 0.95 : 0.65,
    payload,
  });
  return updated;
}

export async function verifyEmailWithZeroBounce(contactId: string) {
  const contact = getContact(contactId);
  if (!contact) throw new Error("Contact not found.");
  if (!contact.email) throw new Error("Add an email before verification.");
  const apiKey = getSecret("ZEROBOUNCE_API_KEY");
  if (!apiKey) {
    throw new Error("ZeroBounce is not configured. Add an API key in Settings.");
  }
  const query = new URLSearchParams({
    email: contact.email,
    api_key: apiKey,
    timeout: "30",
  });
  const response = await fetchWithTimeout(
    `https://api.zerobounce.net/v2/validate?${query}`,
    {},
    35_000,
  );
  const payload = (await response.json()) as {
    address?: string;
    status?: string;
    sub_status?: string;
    did_you_mean?: string | null;
    domain_age_days?: string | number | null;
    active_in_days?: string | null;
    error?: string;
  };
  if (payload.error) throw new Error(payload.error);
  const status: InternalEmailStatus =
    payload.status === "valid"
      ? "valid"
      : payload.status === "invalid"
        ? "invalid"
        : payload.status === "catch-all"
          ? "accept_all"
          : payload.status === "unknown"
            ? "unknown"
            : payload.sub_status === "disposable"
              ? "disposable"
              : "do_not_mail";
  const verifiedAt = new Date().toISOString();
  const updated = patchContact(contactId, {
    emailStatus: status,
    emailVerifiedAt: verifiedAt,
  });
  if (status === "do_not_mail") {
    addSuppression(
      contact.email,
      "email",
      `ZeroBounce returned ${payload.status || "do_not_mail"} (${payload.sub_status || "no sub-status"}).`,
    );
  }
  addEvidence({
    entityType: "contact",
    entityId: contactId,
    fieldName: "email_verification",
    value: `${contact.email}: ${status}`,
    sourceType: "zerobounce",
    sourceLabel: "ZeroBounce Email Validation",
    excerpt: `ZeroBounce status ${payload.status || "unknown"}; ${payload.sub_status || "no sub-status"}`,
    confidence: status === "valid" ? 0.9 : status === "invalid" ? 0.95 : 0.7,
    payload,
  });
  return updated;
}

export async function findEmailWithHunter(companyId: string, contactId: string) {
  const company = getCompany(companyId);
  const contact = getContact(contactId);
  if (!company || !contact) throw new Error("Company or contact not found.");
  if (!company.domain) throw new Error("Confirm the company domain first.");
  const query = new URLSearchParams({
    domain: company.domain,
    full_name: contact.fullName,
  });
  const response = await fetchWithTimeout(
    `https://api.hunter.io/v2/email-finder?${query}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${hunterKey()}`,
      },
    },
    30_000,
  );
  const payload = (await response.json()) as {
    data?: {
      email?: string;
      score?: number;
      verification?: { status?: string; date?: string };
      sources?: Array<{ uri?: string; last_seen_on?: string }>;
    };
  };
  if (!payload.data?.email) throw new Error("Hunter did not find an email.");
  const status = mapHunterStatus(payload.data.verification?.status);
  const updated = patchContact(contactId, {
    email: payload.data.email,
    emailType: payload.data.email.endsWith(`@${company.domain}`)
      ? "work"
      : "personal",
    emailStatus: status,
    emailVerifiedAt: payload.data.verification?.date || new Date().toISOString(),
  });
  addEvidence({
    entityType: "contact",
    entityId: contactId,
    fieldName: "email",
    value: payload.data.email,
    sourceType: "hunter",
    sourceLabel: "Hunter Email Finder",
    sourceUrl: payload.data.sources?.[0]?.uri || null,
    excerpt: `Hunter confidence ${payload.data.score ?? "n/a"}; ${status}`,
    confidence: Math.min(0.95, Math.max(0.5, (payload.data.score || 50) / 100)),
    payload,
  });
  return updated;
}
