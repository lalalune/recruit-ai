import {
  addEvidence,
  addSuppression,
  getCompany,
  getContact,
  patchContact,
} from "../repository";
import { z } from "zod";
import { normalizeEmailAddress } from "../database";
import { conflict, notFound, upstreamFailure } from "../errors";
import { getSecret } from "../secrets";
import { fetchProviderResponse, readBoundedJson } from "./http";

type InternalEmailStatus =
  | "valid"
  | "invalid"
  | "accept_all"
  | "unknown"
  | "disposable"
  | "do_not_mail"
  | "unverified";

const ProviderTextSchema = z.string().max(1_000);
const ProviderUrlSchema = z.string().max(2_048);
const HunterSourceSchema = z.object({
  uri: ProviderUrlSchema.optional(),
  last_seen_on: z.string().max(64).optional(),
});
const HunterErrorSchema = z.object({
  id: z.string().max(100).optional(),
  details: ProviderTextSchema.optional(),
});
const HunterVerifierPayloadSchema = z.object({
  data: z
    .object({
      email: z.string().max(320).optional(),
      status: z.string().max(64).optional(),
      score: z.number().min(0).max(100).optional(),
      sources: z.array(HunterSourceSchema).max(100).optional(),
    })
    .optional(),
  errors: z.array(HunterErrorSchema).max(25).optional(),
});
const HunterFinderPayloadSchema = z.object({
  data: z
    .object({
      email: z.string().max(320).optional(),
      score: z.number().min(0).max(100).optional(),
      verification: z
        .object({
          status: z.string().max(64).optional(),
          date: z.string().max(64).optional(),
        })
        .optional(),
      sources: z.array(HunterSourceSchema).max(100).optional(),
    })
    .optional(),
  errors: z.array(HunterErrorSchema).max(25).optional(),
});
const ZeroBouncePayloadSchema = z.object({
  address: z.string().max(320).optional(),
  status: z.string().max(64).optional(),
  sub_status: z.string().max(100).optional(),
  did_you_mean: z.string().max(320).nullable().optional(),
  domain_age_days: z
    .union([z.string().max(32), z.number().min(0).max(1_000_000)])
    .nullable()
    .optional(),
  active_in_days: z.string().max(32).nullable().optional(),
  error: ProviderTextSchema.optional(),
});

function hunterKey() {
  const key = getSecret("HUNTER_API_KEY");
  if (!key) {
    throw conflict(
      "Hunter is not configured. Add an API key in Settings.",
      "provider_not_configured",
    );
  }
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

function assertEmailUnchanged(contactId: string, expectedEmail: string) {
  const current = getContact(contactId);
  if (!current || current.email !== expectedEmail) {
    throw conflict(
      "The contact email changed while verification was running. The stale result was discarded.",
      "stale_provider_result",
    );
  }
  return current;
}

function assertProviderEmail(
  provider: string,
  returnedEmail: string | undefined,
  expectedEmail: string,
) {
  const normalized = normalizeEmailAddress(returnedEmail);
  if (!normalized || normalized !== expectedEmail) {
    throw upstreamFailure(
      `${provider} returned a result for a different or missing email address. No changes were saved.`,
      "provider_identity_mismatch",
    );
  }
}

export async function verifyEmailWithHunter(contactId: string) {
  const contact = getContact(contactId);
  if (!contact) throw notFound("Contact not found.");
  if (!contact.email) throw conflict("Add an email before verification.");
  const expectedEmail = contact.email;
  const query = new URLSearchParams({
    email: contact.email,
  });
  const response = await fetchProviderResponse(
    "Hunter",
    `https://api.hunter.io/v2/email-verifier?${query}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${hunterKey()}`,
      },
    },
    30_000,
  );
  const payload = await readBoundedJson(
    response,
    "Hunter",
    HunterVerifierPayloadSchema,
    750_000,
  );
  assertEmailUnchanged(contactId, expectedEmail);
  if (payload.errors?.some((error) => error.id === "claimed_email")) {
    addSuppression(
      expectedEmail,
      "email",
      "Hunter reports that the address owner requested no processing.",
    );
    patchContact(contactId, {
      emailStatus: "do_not_mail",
      emailVerifiedAt: new Date().toISOString(),
    });
    throw conflict(
      "The email owner has requested that this address not be processed.",
      "address_claimed",
    );
  }
  if (!response.ok || payload.errors?.length) {
    throw upstreamFailure(
      `Hunter rejected the verification request${
        response.ok ? "" : ` (HTTP ${response.status})`
      }.`,
      "hunter_request_rejected",
    );
  }
  if (!payload.data?.status) {
    throw upstreamFailure("Hunter returned no verification status.");
  }
  assertProviderEmail("Hunter", payload.data.email, expectedEmail);
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
    value: `${expectedEmail}: ${status}`,
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
  if (!contact) throw notFound("Contact not found.");
  if (!contact.email) throw conflict("Add an email before verification.");
  const expectedEmail = contact.email;
  const apiKey = getSecret("ZEROBOUNCE_API_KEY");
  if (!apiKey) {
    throw conflict(
      "ZeroBounce is not configured. Add an API key in Settings.",
      "provider_not_configured",
    );
  }
  const query = new URLSearchParams({
    email: contact.email,
    api_key: apiKey,
    timeout: "30",
  });
  const response = await fetchProviderResponse(
    "ZeroBounce",
    `https://api.zerobounce.net/v2/validate?${query}`,
    {},
    35_000,
  );
  const payload = await readBoundedJson(
    response,
    "ZeroBounce",
    ZeroBouncePayloadSchema,
    250_000,
  );
  assertEmailUnchanged(contactId, expectedEmail);
  if (!response.ok || payload.error) {
    throw upstreamFailure(
      `ZeroBounce rejected the verification request${
        response.ok ? "" : ` (HTTP ${response.status})`
      }.`,
      "zerobounce_request_rejected",
    );
  }
  if (!payload.status) {
    throw upstreamFailure("ZeroBounce returned no verification status.");
  }
  assertProviderEmail("ZeroBounce", payload.address, expectedEmail);
  const status: InternalEmailStatus =
    payload.sub_status === "disposable"
      ? "disposable"
      : payload.status === "valid"
        ? "valid"
        : payload.status === "invalid"
          ? "invalid"
          : payload.status === "catch-all"
            ? "accept_all"
            : payload.status === "unknown"
              ? "unknown"
              : ["spamtrap", "abuse", "do_not_mail"].includes(payload.status)
                ? "do_not_mail"
                : (() => {
                    throw upstreamFailure(
                      `ZeroBounce returned an unsupported status: ${payload.status}.`,
                    );
                  })();
  const verifiedAt = new Date().toISOString();
  const updated = patchContact(contactId, {
    emailStatus: status,
    emailVerifiedAt: verifiedAt,
  });
  if (status === "do_not_mail") {
    addSuppression(
      expectedEmail,
      "email",
      `ZeroBounce returned ${payload.status || "do_not_mail"} (${payload.sub_status || "no sub-status"}).`,
    );
  }
  addEvidence({
    entityType: "contact",
    entityId: contactId,
    fieldName: "email_verification",
    value: `${expectedEmail}: ${status}`,
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
  if (!company || !contact) throw notFound("Company or contact not found.");
  if (!company.contacts.some((item) => item.id === contactId)) {
    throw conflict("The selected contact does not belong to this company.");
  }
  if (!company.domain) throw conflict("Confirm the company domain first.");
  const expectedDomain = company.domain;
  const expectedName = contact.fullName;
  const expectedCompanyUpdatedAt = company.updatedAt;
  const expectedContact = JSON.stringify(contact);
  const query = new URLSearchParams({
    domain: expectedDomain,
    full_name: expectedName,
  });
  const response = await fetchProviderResponse(
    "Hunter",
    `https://api.hunter.io/v2/email-finder?${query}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${hunterKey()}`,
      },
    },
    30_000,
  );
  const payload = await readBoundedJson(
    response,
    "Hunter",
    HunterFinderPayloadSchema,
    750_000,
  );
  const currentCompany = getCompany(companyId);
  const currentContact = getContact(contactId);
  if (
    !currentCompany ||
    currentCompany.domain !== expectedDomain ||
    currentCompany.updatedAt !== expectedCompanyUpdatedAt ||
    !currentCompany.contacts.some((item) => item.id === contactId) ||
    !currentContact ||
    currentContact.fullName !== expectedName ||
    JSON.stringify(currentContact) !== expectedContact
  ) {
    throw conflict(
      "The company or contact changed while the finder was running. The stale result was discarded.",
      "stale_provider_result",
    );
  }
  if (!response.ok || payload.errors?.length) {
    throw upstreamFailure(
      `Hunter rejected the finder request${
        response.ok ? "" : ` (HTTP ${response.status})`
      }.`,
      "hunter_request_rejected",
    );
  }
  if (!payload.data?.email) throw conflict("Hunter did not find an email.");
  const foundEmail = normalizeEmailAddress(payload.data.email);
  if (!foundEmail) {
    throw upstreamFailure("Hunter returned an invalid email address.");
  }
  const updated = patchContact(contactId, {
    email: foundEmail,
    emailType: foundEmail.endsWith(`@${expectedDomain}`)
      ? "work"
      : "personal",
    emailStatus: "unverified",
    emailVerifiedAt: null,
  });
  addEvidence({
    entityType: "contact",
    entityId: contactId,
    fieldName: "email",
    value: foundEmail,
    sourceType: "hunter",
    sourceLabel: "Hunter Email Finder",
    sourceUrl: payload.data.sources?.[0]?.uri || null,
    excerpt: `Hunter finder confidence ${payload.data.score ?? "n/a"}; verification is still required`,
    confidence: Math.min(0.95, Math.max(0.5, (payload.data.score || 50) / 100)),
    payload,
  });
  return updated;
}
