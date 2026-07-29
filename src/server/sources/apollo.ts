import {
  addContact,
  addEvidence,
  getCompany,
  getSettings,
  patchCompany,
  upsertCompany,
} from "../repository";
import { normalizeEmailAddress } from "../database";
import { getSecret } from "../secrets";
import { conflict, notFound, upstreamFailure } from "../errors";
import { z } from "zod";
import { fetchProviderResponse, readBoundedJson } from "./http";

const ApolloShortTextSchema = z.string().max(1_000);
const ApolloUrlSchema = z.string().max(2_048);
const ApolloOrganizationSchema = z.object({
  id: z.string().max(200).optional(),
  name: ApolloShortTextSchema.optional(),
  website_url: ApolloUrlSchema.optional(),
  primary_domain: z.string().max(253).optional(),
  linkedin_url: ApolloUrlSchema.optional(),
  industry: ApolloShortTextSchema.optional(),
  estimated_num_employees: z.number().int().min(0).max(10_000_000).optional(),
  founded_year: z.number().int().min(1800).max(2200).optional(),
  short_description: z.string().max(10_000).optional(),
  city: ApolloShortTextSchema.optional(),
  state: ApolloShortTextSchema.optional(),
  country: ApolloShortTextSchema.optional(),
  num_current_job_postings: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .optional(),
});
type ApolloOrganization = z.infer<typeof ApolloOrganizationSchema>;

const ApolloPersonSchema = z.object({
  id: z.string().max(200).optional(),
  first_name: ApolloShortTextSchema.optional(),
  last_name: ApolloShortTextSchema.optional(),
  name: ApolloShortTextSchema.optional(),
  title: ApolloShortTextSchema.optional(),
  linkedin_url: ApolloUrlSchema.optional(),
  email: z.string().max(320).optional(),
  email_status: z.string().max(100).optional(),
  organization: ApolloOrganizationSchema.optional(),
});
type ApolloPerson = z.infer<typeof ApolloPersonSchema>;

const ApolloErrorFields = {
  error: z
    .union([
      z.string().max(1_000),
      z.object({ message: z.string().max(1_000).optional() }),
    ])
    .optional(),
  message: z.string().max(1_000).optional(),
};
const ApolloOrganizationSearchSchema = z.object({
  organizations: z.array(ApolloOrganizationSchema).max(100).optional(),
  ...ApolloErrorFields,
});
const ApolloPeopleSearchSchema = z.object({
  people: z.array(ApolloPersonSchema).max(100).optional(),
  ...ApolloErrorFields,
});
const ApolloPeopleMatchSchema = z.object({
  person: ApolloPersonSchema.nullable().optional(),
  ...ApolloErrorFields,
});

function apolloHeaders() {
  const key = getSecret("APOLLO_API_KEY");
  if (!key) {
    throw conflict(
      "Apollo is not configured. Add an API key in Settings.",
      "provider_not_configured",
    );
  }
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "X-Api-Key": key,
  };
}

function assertApolloResponse(
  response: Response,
  payload: { error?: unknown },
) {
  if (!response.ok || payload.error !== undefined) {
    throw upstreamFailure(
      `Apollo rejected the request (HTTP ${response.status}).`,
      "apollo_request_rejected",
    );
  }
}

type ApolloCompanyAnchor = {
  name: string;
  domain: string | null;
  websiteUrl: string | null;
  updatedAt: string;
};

function companyAnchor(company: ReturnType<typeof getCompany>): ApolloCompanyAnchor {
  if (!company) throw notFound("Company not found.");
  return {
    name: company.name,
    domain: company.domain,
    websiteUrl: company.websiteUrl,
    updatedAt: company.updatedAt,
  };
}

function assertApolloCompanyUnchanged(
  companyId: string,
  expected: ApolloCompanyAnchor,
) {
  const current = getCompany(companyId);
  if (!current) {
    throw conflict(
      "The company changed while Apollo research was running. The stale result was discarded.",
      "stale_provider_result",
    );
  }
  const actual = companyAnchor(current);
  if (
    actual.name !== expected.name ||
    actual.domain !== expected.domain ||
    actual.websiteUrl !== expected.websiteUrl ||
    actual.updatedAt !== expected.updatedAt
  ) {
    throw conflict(
      "The company changed while Apollo research was running. The stale result was discarded.",
      "stale_provider_result",
    );
  }
  return current!;
}

function locationFor(organization: ApolloOrganization) {
  return [organization.city, organization.state, organization.country]
    .filter(Boolean)
    .join(", ")
    .slice(0, 500);
}

function personEvidencePayload(person: ApolloPerson) {
  return {
    id: person.id,
    first_name: person.first_name,
    last_name: person.last_name,
    name: person.name,
    title: person.title,
    linkedin_url: person.linkedin_url,
    email: person.email,
    email_status: person.email_status,
    organization: person.organization
      ? {
          id: person.organization.id,
          name: person.organization.name,
          primary_domain: person.organization.primary_domain,
          website_url: person.organization.website_url,
          linkedin_url: person.organization.linkedin_url,
        }
      : undefined,
  };
}

function upsertApolloOrganization(organization: ApolloOrganization) {
  if (!organization.name) return null;
  const company = upsertCompany({
    name: organization.name,
    domain: organization.primary_domain || organization.website_url,
    websiteUrl: organization.website_url || null,
    linkedinUrl: organization.linkedin_url || null,
    description: organization.short_description || null,
    location: locationFor(organization) || "San Francisco Bay Area",
    employeeCountMin: organization.estimated_num_employees || null,
    employeeCountMax: organization.estimated_num_employees || null,
    industries: organization.industry
      ? [organization.industry.slice(0, 100)]
      : ["Technology"],
    status:
      (organization.num_current_job_postings || 0) > 0
        ? "ready_for_review"
        : "needs_research",
  });
  addEvidence({
    entityType: "company",
    entityId: company.id,
    fieldName: "apollo_organization",
    value: organization.id || organization.primary_domain || organization.name,
    sourceType: "apollo",
    sourceLabel: "Apollo organization",
    sourceUrl: organization.linkedin_url || organization.website_url || null,
    excerpt: [
      organization.industry,
      organization.estimated_num_employees
        ? `${organization.estimated_num_employees} employees`
        : null,
      organization.num_current_job_postings
        ? `${organization.num_current_job_postings} current jobs`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
    confidence: 0.8,
    payload: { ...organization, phone: undefined },
  });
  return company;
}

export async function discoverApollo(limit: number) {
  const settings = getSettings();
  const minimumEmployees = Math.max(1, Number(settings.employeeMin) || 3);
  const maximumEmployees = Math.min(
    10_000,
    Math.max(minimumEmployees, Number(settings.employeeMax) || 1_000),
  );
  const location =
    typeof settings.scopeLocation === "string" && settings.scopeLocation.trim()
      ? settings.scopeLocation.trim()
      : "San Francisco Bay Area";
  const perPage = Math.min(100, limit);
  const pageCount = Math.ceil(limit / perPage);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (let page = 1; page <= pageCount; page++) {
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(Math.min(perPage, limit - inserted - updated)),
      "organization_locations[]": location,
      "organization_num_employees_ranges[]": `${minimumEmployees},${maximumEmployees}`,
      "organization_num_jobs_range[min]": "1",
    });
    const response = await fetchProviderResponse(
      "Apollo",
      `https://api.apollo.io/api/v1/mixed_companies/search?${query}`,
      {
        method: "POST",
        headers: apolloHeaders(),
        body: "{}",
      },
      30_000,
    );
    const payload = await readBoundedJson(
      response,
      "Apollo",
      ApolloOrganizationSearchSchema,
      3_000_000,
    );
    assertApolloResponse(response, payload);
    const organizations = payload.organizations || [];
    if (!organizations.length) break;
    for (const organization of organizations) {
      const company = upsertApolloOrganization(organization);
      if (!company) {
        skipped++;
        continue;
      }
      company.inserted ? inserted++ : updated++;
      if (inserted + updated >= limit) break;
    }
  }
  return { inserted, updated, skipped };
}

export async function enrichCompanyWithApollo(companyId: string, contactLimit = 3) {
  const company = getCompany(companyId);
  if (!company) throw notFound("Company not found.");
  if (!company.domain) {
    throw conflict("Confirm the company domain before searching Apollo people.");
  }
  const expectedCompany = companyAnchor(company);
  const boundedContactLimit = Math.min(
    10,
    Math.max(1, Math.trunc(Number(contactLimit) || 3)),
  );

  const query = new URLSearchParams({
    page: "1",
    per_page: String(Math.min(25, Math.max(boundedContactLimit * 4, 10))),
  });
  query.append("q_organization_domains_list[]", company.domain);
  for (const seniority of ["owner", "founder", "c_suite", "vp", "head", "director"]) {
    query.append("person_seniorities[]", seniority);
  }
  const searchResponse = await fetchProviderResponse(
    "Apollo",
    `https://api.apollo.io/api/v1/mixed_people/api_search?${query}`,
    {
      method: "POST",
      headers: apolloHeaders(),
      body: "{}",
    },
    30_000,
  );
  const searchPayload = await readBoundedJson(
    searchResponse,
    "Apollo",
    ApolloPeopleSearchSchema,
    3_000_000,
  );
  assertApolloResponse(searchResponse, searchPayload);
  const candidates = (searchPayload.people || [])
    .sort(
      (a, b) =>
        roleScore(b.title, company.employeeCountMax) -
        roleScore(a.title, company.employeeCountMax),
    )
    .slice(0, boundedContactLimit);

  const selectedPeople: Array<{
    person: ApolloPerson;
    sourceLabel: string;
  }> = candidates
    .filter((candidate) => Boolean(candidate.id || candidate.name))
    .map((person) => ({
      person,
      sourceLabel: "Apollo people search",
    }));
  if (selectedPeople[0]) {
    const candidate = selectedPeople[0].person;
    const enrichQuery = new URLSearchParams({
      domain: company.domain,
      reveal_personal_emails: "false",
      reveal_phone_number: "false",
    });
    if (candidate.id) enrichQuery.set("id", candidate.id);
    else enrichQuery.set("name", candidate.name || "");
    const enrichResponse = await fetchProviderResponse(
      "Apollo",
      `https://api.apollo.io/api/v1/people/match?${enrichQuery}`,
      {
        method: "POST",
        headers: apolloHeaders(),
        body: "{}",
      },
      30_000,
    );
    const enrichPayload = await readBoundedJson(
      enrichResponse,
      "Apollo",
      ApolloPeopleMatchSchema,
      1_000_000,
    );
    assertApolloResponse(enrichResponse, enrichPayload);
    selectedPeople[0] = {
      person: enrichPayload.person || candidate,
      sourceLabel: "Apollo primary-person enrichment",
    };
  }

  const anchoredCompany = assertApolloCompanyUnchanged(
    companyId,
    expectedCompany,
  );
  const contacts = [];
  for (let index = 0; index < selectedPeople.length; index++) {
    const { person, sourceLabel } = selectedPeople[index];
    const email = normalizeEmailAddress(person.email);
    const emailType = email ? "work" : "unknown";
    // Apollo's provider label is retained as evidence, but a dedicated verifier
    // must establish send readiness.
    const emailStatus = "unverified";
    const contact = addContact(companyId, {
      firstName: person.first_name?.slice(0, 200) || null,
      lastName: person.last_name?.slice(0, 200) || null,
      fullName: (
        person.name ||
        [person.first_name, person.last_name].filter(Boolean).join(" ") ||
        "Unknown"
      ).slice(0, 500),
      title: person.title?.slice(0, 500) || null,
      roleCategory: roleCategory(person.title),
      email,
      emailType,
      emailStatus,
      emailVerifiedAt: null,
      linkedinUrl: person.linkedin_url || null,
      rank: index + 1,
      status: index === 0 ? "primary" : "alternate",
    });
    if (!contact) continue;
    contacts.push(contact);
    addEvidence({
      entityType: "contact",
      entityId: contact.id,
      fieldName: "identity_and_employment",
      value: `${contact.fullName} — ${contact.title || "Unknown title"}`,
      sourceType: "apollo",
      sourceLabel,
      sourceUrl: contact.linkedinUrl,
      excerpt: `${contact.fullName} at ${anchoredCompany.name}`,
      confidence: index === 0 ? 0.75 : 0.65,
      payload: personEvidencePayload(person),
    });
    if (email) {
      addEvidence({
        entityType: "contact",
        entityId: contact.id,
        fieldName: "email",
        value: email,
        sourceType: "apollo",
        sourceLabel,
        confidence: person.email_status === "verified" ? 0.8 : 0.6,
        payload: { emailStatus: person.email_status },
      });
    }
  }
  patchCompany(companyId, {
    lastResearchedAt: new Date().toISOString(),
    status: contacts.length ? "ready_for_review" : anchoredCompany.status,
  });
  return contacts;
}

function roleScore(title?: string | null, employeeCountMax?: number | null) {
  const value = (title || "").toLowerCase();
  const founder = /\b(founder|co-founder|ceo|chief executive)\b/.test(value);
  const operations = /\b(coo|chief operating)\b/.test(value);
  const seniorPeople =
    /\b(chief people|chief human|vp people|vp talent|head of (people|talent|recruit)|talent acquisition)\b/.test(
      value,
    );
  const recruitingLeader =
    /\b(director|head|lead).*(people|talent|recruit)\b/.test(value);
  const functionalExecutive =
    /\b(vp|vice president|head|director|chief)\b/.test(value);
  const size = employeeCountMax || 0;
  if (size > 0 && size <= 20) {
    if (founder) return 100;
    if (operations) return 95;
    if (functionalExecutive) return 82;
    if (seniorPeople || recruitingLeader) return 78;
  } else if (size > 20 && size <= 75) {
    if (seniorPeople) return 100;
    if (founder || operations) return 95;
    if (recruitingLeader) return 90;
    if (functionalExecutive) return 82;
  } else if (size > 75) {
    if (seniorPeople) return 100;
    if (recruitingLeader) return 96;
    if (functionalExecutive) return 90;
    if (operations) return 86;
    if (founder) return 80;
  }
  if (founder) return 95;
  if (operations) return 92;
  if (seniorPeople) return 90;
  if (recruitingLeader) return 84;
  if (functionalExecutive) return 72;
  return 30;
}

function roleCategory(title?: string | null) {
  const value = (title || "").toLowerCase();
  if (/\b(founder|co-founder|ceo|chief executive)\b/.test(value)) return "founder";
  if (/\b(people|human resources|hr)\b/.test(value)) return "people";
  if (/\b(talent|recruit)\b/.test(value)) return "talent";
  if (/\b(coo|operations)\b/.test(value)) return "operations";
  return "functional_leader";
}
