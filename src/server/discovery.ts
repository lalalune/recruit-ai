import Papa from "papaparse";
import { createHash } from "node:crypto";
import type { DiscoveryRunRequest } from "../shared/types";
import { getDatabase } from "./database";
import {
  addContact,
  addEvidence,
  createSourceRun,
  finishSourceRun,
  listCompaniesForWebsiteResearch,
  patchCompany,
  startSourceRun,
  upsertCompany,
  upsertJob,
} from "./repository";
import { discoverApollo } from "./sources/apollo";
import { discoverDataSf } from "./sources/datasf";
import { discoverHackerNews } from "./sources/hackernews";
import { ingestAshby, ingestGreenhouse, ingestLever } from "./sources/jobBoards";
import { resolveMissingDomains } from "./sources/webSearch";
import { mapWithConcurrency } from "./sources/http";
import { researchCompanyWebsite } from "./sources/website";

export function startDiscovery(request: DiscoveryRunRequest) {
  const run = createSourceRun(
    request.source === "job_board" ? request.provider : request.source,
    request,
  );
  if (run.created) void executeDiscovery(run.id, request);
  return run.id;
}

async function executeDiscovery(runId: string, request: DiscoveryRunRequest) {
  try {
    startSourceRun(runId);
    let result = { inserted: 0, updated: 0, skipped: 0 };
    switch (request.source) {
      case "datasf":
        result = await discoverDataSf(request.limit, request.technologyOnly);
        break;
      case "hackernews":
        result = await discoverHackerNews(request.limit);
        break;
      case "apollo":
        result = await discoverApollo(request.limit);
        break;
      case "brave_domains":
        result = await resolveMissingDomains(
          request.limit,
          request.autoApplyHighConfidence,
        );
        break;
      case "company_websites": {
        const companyIds = listCompaniesForWebsiteResearch(request.limit);
        const outcomes = await mapWithConcurrency(companyIds, 3, async (companyId) => {
          try {
            const researched = await researchCompanyWebsite(companyId);
            return researched.pagesFetched > 0;
          } catch {
            return false;
          }
        });
        const updated = outcomes.filter(Boolean).length;
        result = {
          inserted: 0,
          updated,
          skipped: companyIds.length - updated,
        };
        break;
      }
      case "job_board":
        result =
          request.provider === "greenhouse"
            ? await ingestGreenhouse(request.identifier, request.companyId)
            : request.provider === "lever"
              ? await ingestLever(request.identifier, request.companyId)
              : await ingestAshby(request.identifier, request.companyId);
        break;
    }
    finishSourceRun(runId, result);
  } catch (error) {
    finishSourceRun(runId, {
      inserted: 0,
      updated: 0,
      skipped: 0,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function valueFor(
  row: Record<string, string>,
  candidates: string[],
): string | undefined {
  const entries = Object.entries(row);
  for (const candidate of candidates) {
    const match = entries.find(
      ([key]) =>
        key.toLowerCase().replace(/[^a-z0-9]/g, "") ===
        candidate.toLowerCase().replace(/[^a-z0-9]/g, ""),
    );
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function parseCount(value?: string) {
  if (!value) return null;
  const number = Number(value.replace(/[^0-9]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function parseSizeRange(value?: string) {
  if (!value) return { minimum: null, maximum: null };
  const values = value.match(/\d[\d,]*/g)?.map((item) =>
    Number(item.replaceAll(",", "")),
  );
  if (!values?.length) return { minimum: null, maximum: null };
  if (values.length === 1) return { minimum: values[0], maximum: values[0] };
  return {
    minimum: Math.min(values[0], values[1]),
    maximum: Math.max(values[0], values[1]),
  };
}

export function importCsv(
  csv: string,
  sourceLabel: string,
  mapping: Record<string, string> = {},
) {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });
  if (parsed.errors.length && !parsed.data.length) {
    throw new Error(parsed.errors[0]?.message || "Could not parse CSV.");
  }
  if (parsed.data.length > 10_000) {
    throw new Error("A single CSV import is limited to 10,000 data rows.");
  }
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let contacts = 0;
  const run = createSourceRun("csv", {
    sourceLabel,
    rows: parsed.data.length,
    contentHash: createHash("sha256").update(csv).digest("hex"),
    mapping,
  });
  if (!run.created) {
    return {
      runId: run.id,
      inserted,
      updated,
      skipped,
      contacts,
      parseWarnings: ["An identical CSV import is already running."],
    };
  }
  startSourceRun(run.id);
  try {
    getDatabase().transaction(() => {
      for (const sourceRow of parsed.data) {
      const row: Record<string, string> = Object.keys(mapping).length
        ? {}
        : { ...sourceRow };
      for (const [sourceColumn, canonicalField] of Object.entries(mapping)) {
        if (canonicalField === "ignore") continue;
        const value = sourceRow[sourceColumn];
        if (value !== undefined && value !== "") row[canonicalField] = value;
      }
      const name = valueFor(row, [
        "company_name",
        "company",
        "name",
        "organization",
        "organization_name",
      ]);
      if (!name) {
        skipped++;
        continue;
      }
      const industry = valueFor(row, [
        "industry",
        "industries",
        "sector",
        "tags",
        "technology_tags",
      ]);
      const sizeRange = parseSizeRange(
        valueFor(row, ["company_size", "size", "employee_range"]),
      );
      const company = upsertCompany({
        name,
        domain: valueFor(row, ["domain", "canonical_domain"]),
        websiteUrl: valueFor(row, ["website", "website_url", "company_url"]),
        linkedinUrl: valueFor(row, ["company_linkedin_url", "linkedin_company"]),
        ycUrl: valueFor(row, ["yc_url"]),
        description: valueFor(row, ["description", "company_description"]),
        location: valueFor(row, [
          "location",
          "city",
          "hq_city",
          "headquarters",
        ]),
        employeeCountMin: parseCount(
          valueFor(row, ["employee_count_min", "employees_min"]),
        ) ?? sizeRange.minimum,
        employeeCountMax: parseCount(
          valueFor(row, ["employee_count_max", "employee_count", "employees"]),
        ) ?? sizeRange.maximum,
        industries: industry
          ? industry.split(/[,;|]/).map((value) => value.trim()).filter(Boolean)
          : [],
        stage: valueFor(row, ["stage", "funding_stage"]),
        status: "needs_research",
      });
      patchCompany(company.id, {
        reviewed: false,
        status: "needs_research",
        ...(valueFor(row, ["notes"])
          ? { notes: valueFor(row, ["notes"]) }
          : {}),
      });
      company.inserted ? inserted++ : updated++;
      addEvidence({
        entityType: "company",
        entityId: company.id,
        fieldName: "csv_import",
        value: name,
        sourceType: "csv",
        sourceLabel,
        confidence: 0.5,
        sourceUrl: valueFor(row, ["source_url"]) || null,
        payload: { runId: run.id, row },
      });

      const firstName = valueFor(row, ["first_name"]);
      const lastName = valueFor(row, ["last_name"]);
      const fullName =
        valueFor(row, [
          "full_name",
          "contact",
          "contact_name",
          "person_name",
        ]) || [firstName, lastName].filter(Boolean).join(" ");
      if (fullName) {
        const importedPhone = valueFor(row, ["phone", "primary_phone"]);
        const phoneConfirmed = /^(1|true|yes)$/i.test(
          valueFor(row, ["phone_confirmed", "confirmed_phone"]) || "",
        );
        const phoneSource = valueFor(row, [
          "phone_source",
          "phone_source_url",
          "source_url",
          "notes",
        ]);
        const contact = addContact(company.id, {
          fullName,
          firstName,
          lastName,
          title: valueFor(row, ["title", "job_title", "role"]),
          roleCategory: valueFor(row, ["role_category"]),
          email: valueFor(row, ["email", "primary_email", "work_email"]),
          emailType: ["work", "personal", "generic", "unknown"].includes(
            (valueFor(row, ["email_kind", "email_type"]) || "").toLowerCase(),
          )
            ? (valueFor(row, ["email_kind", "email_type"]) || "").toLowerCase()
            : "unknown",
          // Imported labels are retained in source evidence but never treated as
          // a current verifier result inside RecruitAI.
          emailStatus: "unverified",
          emailVerifiedAt: null,
          phone:
            importedPhone && phoneConfirmed && phoneSource
              ? importedPhone
              : null,
          phoneType: [
            "business",
            "direct",
            "mobile",
            "switchboard",
            "unknown",
          ].includes(
            (valueFor(row, ["phone_kind", "phone_type"]) || "").toLowerCase(),
          )
            ? (valueFor(row, ["phone_kind", "phone_type"]) || "").toLowerCase()
            : "unknown",
          phoneConfirmed: Boolean(
            importedPhone && phoneConfirmed && phoneSource,
          ),
          phoneSource: phoneSource || null,
          linkedinUrl: valueFor(row, [
            "person_linkedin_url",
            "linkedin_url",
            "profile_url",
          ]),
          rank: Math.min(
            99,
            Math.max(
              1,
              parseCount(valueFor(row, ["target_rank", "rank"])) || 1,
            ),
          ),
          status: "candidate",
          ...(valueFor(row, ["notes"])
            ? { notes: valueFor(row, ["notes"]) }
            : {}),
        });
        if (contact) {
          contacts++;
          addEvidence({
            entityType: "contact",
            entityId: contact.id,
            fieldName: "csv_import",
            value: fullName,
            sourceType: "csv",
            sourceLabel,
            confidence: 0.5,
            sourceUrl: valueFor(row, ["source_url"]) || null,
            payload: { runId: run.id, row },
          });
        }
      }
      }
    })();
    const result = {
      runId: run.id,
      inserted,
      updated,
      skipped,
      contacts,
      parseWarnings: parsed.errors.map((error) => error.message),
    };
    finishSourceRun(run.id, result);
    return result;
  } catch (error) {
    finishSourceRun(run.id, {
      inserted,
      updated,
      skipped,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function loadDemoWorkspace() {
  const demoCompanies = [
    {
      name: "Northstar Robotics",
      domain: "northstar-robotics.example",
      description: "Warehouse robotics and vision systems.",
      industries: ["Robotics", "Computer vision"],
      employees: 18,
      jobs: ["Founding Robotics Engineer", "Computer Vision Engineer"],
      contact: ["Maya Chen", "Co-founder & CEO", "maya@northstar-robotics.example"],
    },
    {
      name: "Tandem Compute",
      domain: "tandem-compute.example",
      description: "Infrastructure for efficient model training.",
      industries: ["AI infrastructure", "Data"],
      employees: 62,
      jobs: ["Staff Distributed Systems Engineer", "ML Systems Engineer", "Product Lead"],
      contact: ["Eli Brooks", "COO", "eli@tandem-compute.example"],
    },
    {
      name: "Arc Materials",
      domain: "arc-materials.example",
      description: "AI-assisted materials discovery for advanced manufacturing.",
      industries: ["Research", "Manufacturing"],
      employees: 140,
      jobs: ["Research Scientist", "Director of Manufacturing"],
      contact: ["Sam Rivera", "Head of People", "sam@arc-materials.example"],
    },
  ];
  let inserted = 0;
  for (const item of demoCompanies) {
    const company = upsertCompany({
      name: item.name,
      domain: item.domain,
      websiteUrl: `https://${item.domain}`,
      description: item.description,
      location: "San Francisco Bay Area",
      employeeCountMin: item.employees,
      employeeCountMax: item.employees,
      industries: item.industries,
      status: "ready_for_review",
      priority: "high",
    });
    patchCompany(company.id, {
      fitConfirmed: true,
      recruitingFit: "likely",
      recruitingFitNote: "Fictional demo company with no internal recruiting team.",
    });
    if (company.inserted) inserted++;
    addEvidence({
      entityType: "company",
      entityId: company.id,
      fieldName: "hiring_signal",
      value: `${item.jobs.length} demo roles`,
      sourceType: "demo",
      sourceLabel: "Fictional demo fixture",
      confidence: 1,
    });
    item.jobs.forEach((title, index) =>
      upsertJob({
        companyId: company.id,
        externalId: `demo-${index}`,
        title,
        location: "San Francisco, CA",
        sourceType: "demo",
        postedAt: new Date(Date.now() - index * 86_400_000).toISOString(),
        url: `https://${item.domain}/jobs/${index + 1}`,
      }),
    );
    const contact = addContact(company.id, {
      fullName: item.contact[0],
      title: item.contact[1],
      email: item.contact[2],
      emailType: "work",
      emailStatus: "valid",
      emailVerifiedAt: new Date().toISOString(),
      rank: 1,
      status: "primary",
      employmentConfirmed: true,
      observedTitle: item.contact[1],
      employmentObservedAt: new Date().toISOString(),
      reviewed: true,
    });
    if (contact) {
      addEvidence({
        entityType: "contact",
        entityId: contact.id,
        fieldName: "identity_and_employment",
        value: `${item.contact[0]} — ${item.contact[1]}`,
        sourceType: "demo",
        sourceLabel: "Fictional demo fixture",
        confidence: 1,
      });
    }
  }
  return { inserted, total: demoCompanies.length };
}
