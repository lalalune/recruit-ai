import {
  addContact,
  addEvidence,
  getCompany,
  getSettings,
  patchCompany,
  upsertCompany,
} from "../repository";
import { getSecret } from "../secrets";
import { fetchWithTimeout } from "./http";

interface ApolloOrganization {
  id?: string;
  name?: string;
  website_url?: string;
  primary_domain?: string;
  linkedin_url?: string;
  industry?: string;
  estimated_num_employees?: number;
  founded_year?: number;
  short_description?: string;
  city?: string;
  state?: string;
  country?: string;
  phone?: string;
  num_current_job_postings?: number;
}

interface ApolloPerson {
  id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  linkedin_url?: string;
  email?: string;
  email_status?: string;
  organization?: ApolloOrganization;
}

function apolloHeaders() {
  const key = getSecret("APOLLO_API_KEY");
  if (!key) {
    throw new Error("Apollo is not configured. Add an API key in Settings.");
  }
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "X-Api-Key": key,
  };
}

function locationFor(organization: ApolloOrganization) {
  return [organization.city, organization.state, organization.country]
    .filter(Boolean)
    .join(", ");
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
    industries: organization.industry ? [organization.industry] : ["Technology"],
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
    const response = await fetchWithTimeout(
      `https://api.apollo.io/api/v1/mixed_companies/search?${query}`,
      {
        method: "POST",
        headers: apolloHeaders(),
        body: "{}",
      },
      30_000,
    );
    const payload = (await response.json()) as {
      organizations?: ApolloOrganization[];
    };
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
  if (!company) throw new Error("Company not found.");
  if (!company.domain) {
    throw new Error("Confirm the company domain before searching Apollo people.");
  }

  const query = new URLSearchParams({
    page: "1",
    per_page: String(Math.min(25, Math.max(contactLimit * 4, 10))),
  });
  query.append("q_organization_domains_list[]", company.domain);
  for (const seniority of ["owner", "founder", "c_suite", "vp", "head", "director"]) {
    query.append("person_seniorities[]", seniority);
  }
  const searchResponse = await fetchWithTimeout(
    `https://api.apollo.io/api/v1/mixed_people/api_search?${query}`,
    {
      method: "POST",
      headers: apolloHeaders(),
      body: "{}",
    },
    30_000,
  );
  const searchPayload = (await searchResponse.json()) as {
    people?: ApolloPerson[];
  };
  const candidates = (searchPayload.people || [])
    .sort(
      (a, b) =>
        roleScore(b.title, company.employeeCountMax) -
        roleScore(a.title, company.employeeCountMax),
    )
    .slice(0, contactLimit);

  const contacts = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!candidate.id && !candidate.name) continue;
    // People search supplies the ranked candidate list. Spend an enrichment
    // credit only on the current primary; alternates stay as names/titles until
    // the owner deliberately advances them in a later round.
    let person = candidate;
    let sourceLabel = "Apollo people search";
    if (index === 0) {
      const enrichQuery = new URLSearchParams({
        domain: company.domain,
        reveal_personal_emails: "false",
        reveal_phone_number: "false",
      });
      if (candidate.id) enrichQuery.set("id", candidate.id);
      else enrichQuery.set("name", candidate.name || "");
      const enrichResponse = await fetchWithTimeout(
        `https://api.apollo.io/api/v1/people/match?${enrichQuery}`,
        {
          method: "POST",
          headers: apolloHeaders(),
          body: "{}",
        },
        30_000,
      );
      const enrichPayload = (await enrichResponse.json()) as {
        person?: ApolloPerson | null;
      };
      person = enrichPayload.person || candidate;
      sourceLabel = "Apollo primary-person enrichment";
    }
    const email = person.email || null;
    const emailType = email ? "work" : "unknown";
    // Apollo's provider label is retained as evidence, but a dedicated verifier
    // must establish send readiness.
    const emailStatus = "unverified";
    const contact = addContact(companyId, {
      firstName: person.first_name || null,
      lastName: person.last_name || null,
      fullName:
        person.name ||
        [person.first_name, person.last_name].filter(Boolean).join(" ") ||
        "Unknown",
      title: person.title || null,
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
      excerpt: `${contact.fullName} at ${company.name}`,
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
    status: contacts.length ? "ready_for_review" : company.status,
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
