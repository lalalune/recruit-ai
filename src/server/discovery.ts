import Papa from "papaparse";
import { createHash } from "node:crypto";
import {
  CompanyPatchSchema,
  ContactPatchSchema,
  type DiscoveryRunRequest,
} from "../shared/types";
import { getDatabase } from "./database";
import { badRequest } from "./errors";
import {
  addAudit,
  addContact,
  addEvidence,
  createSourceRun,
  finishSourceRun,
  getCompany,
  listCompaniesMissingDomain,
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
import { resolveCompanyDomainWithBrave } from "./sources/webSearch";
import { mapWithConcurrency } from "./sources/http";
import { researchCompanyWebsite } from "./sources/website";
import { reserveMutableOperation } from "./operationState";

interface DiscoveryResult {
  inserted: number;
  updated: number;
  skipped: number;
  error?: string;
}

interface BatchFailure {
  companyId: string;
  companyLabel: string;
  message: string;
}

function readableFailure(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300) || "Unknown error";
}

function batchFailureMessage(
  sourceLabel: string,
  attempted: number,
  failures: BatchFailure[],
) {
  if (!failures.length) return undefined;
  const summary =
    failures.length === attempted
      ? `All ${attempted} ${sourceLabel} attempts failed.`
      : `${failures.length} of ${attempted} ${sourceLabel} attempts failed.`;
  const details = failures
    .slice(0, 10)
    .map(
      (failure) =>
        `${failure.companyLabel} (${failure.companyId}): ${failure.message}`,
    )
    .join(" | ");
  const omitted =
    failures.length > 10 ? ` | ${failures.length - 10} more failure(s) omitted.` : "";
  return `${summary} ${details}${omitted}`.trim();
}

function recordBatchFailures(
  runId: string,
  sourceType: "brave_domains" | "company_websites",
  failures: BatchFailure[],
) {
  for (const failure of failures) {
    addAudit(
      "discovery.company_failed",
      "company",
      failure.companyId,
      `${sourceType === "brave_domains" ? "Brave domain resolution" : "Company website research"} failed: ${failure.message}`,
      { runId, sourceType, error: failure.message },
    );
  }
}

export function startDiscovery(request: DiscoveryRunRequest) {
  const releaseOperation = reserveMutableOperation("start a discovery run");
  try {
    const run = createSourceRun(
      request.source === "job_board" ? request.provider : request.source,
      request,
    );
    if (run.created) {
      void executeDiscovery(run.id, request).finally(releaseOperation);
    } else {
      releaseOperation();
    }
    return run.id;
  } catch (error) {
    releaseOperation();
    throw error;
  }
}

async function executeDiscovery(runId: string, request: DiscoveryRunRequest) {
  try {
    startSourceRun(runId);
    let result: DiscoveryResult = { inserted: 0, updated: 0, skipped: 0 };
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
      case "brave_domains": {
        const companyIds = listCompaniesMissingDomain(request.limit);
        const outcomes = await mapWithConcurrency(companyIds, 3, async (companyId) => {
          const companyLabel = getCompany(companyId)?.name || "Unknown company";
          try {
            const value = await resolveCompanyDomainWithBrave(
              companyId,
              request.autoApplyHighConfidence,
            );
            return { ok: true as const, companyId, companyLabel, value };
          } catch (error) {
            return {
              ok: false as const,
              companyId,
              companyLabel,
              message: readableFailure(error),
            };
          }
        });
        const failures = outcomes.filter(
          (outcome): outcome is BatchFailure & { ok: false } => !outcome.ok,
        );
        const successes = outcomes.filter((outcome) => outcome.ok);
        const updated = successes.filter((outcome) => outcome.value.applied).length;
        recordBatchFailures(runId, "brave_domains", failures);
        result = {
          inserted: 0,
          updated,
          skipped: companyIds.length - updated,
          error: batchFailureMessage(
            "Brave domain-resolution",
            companyIds.length,
            failures,
          ),
        };
        break;
      }
      case "company_websites": {
        const companyIds = listCompaniesForWebsiteResearch(request.limit);
        const outcomes = await mapWithConcurrency(companyIds, 3, async (companyId) => {
          const companyLabel = getCompany(companyId)?.name || "Unknown company";
          try {
            const researched = await researchCompanyWebsite(companyId);
            if (researched.pagesFetched < 1) {
              throw new Error("No permitted HTML pages were fetched.");
            }
            return {
              ok: true as const,
              companyId,
              companyLabel,
              value: researched,
            };
          } catch (error) {
            return {
              ok: false as const,
              companyId,
              companyLabel,
              message: readableFailure(error),
            };
          }
        });
        const failures = outcomes.filter(
          (outcome): outcome is BatchFailure & { ok: false } => !outcome.ok,
        );
        const updated = outcomes.length - failures.length;
        recordBatchFailures(runId, "company_websites", failures);
        result = {
          inserted: 0,
          updated,
          skipped: companyIds.length - updated,
          error: batchFailureMessage(
            "company-website research",
            companyIds.length,
            failures,
          ),
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
        normalizedCsvHeader(key) === normalizedCsvHeader(candidate),
    );
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function normalizedCsvHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const retainedCsvEvidenceHeaders = new Set(
  [
    "company",
    "company_name",
    "name",
    "organization",
    "organization_name",
    "domain",
    "canonical_domain",
    "website",
    "website_url",
    "company_url",
    "location",
    "city",
    "hq_city",
    "headquarters",
    "company_size",
    "size",
    "employee_range",
    "employee_count",
    "employee_count_min",
    "employees_min",
    "employee_count_max",
    "employees_max",
    "employees",
    "industry",
    "industries",
    "sector",
    "tags",
    "technology_tags",
    "stage",
    "funding_stage",
    "description",
    "company_description",
    "company_linkedin_url",
    "linkedin_company",
    "yc_url",
    "full_name",
    "contact",
    "contact_name",
    "person_name",
    "first_name",
    "last_name",
    "title",
    "job_title",
    "role",
    "role_category",
    "email",
    "work_email",
    "primary_email",
    "email_type",
    "email_kind",
    "email_status",
    "verification_status",
    "email_verified_at",
    "phone",
    "primary_phone",
    "phone_type",
    "phone_kind",
    "phone_confirmed",
    "confirmed_phone",
    "phone_source",
    "phone_source_url",
    "person_linkedin_url",
    "linkedin_url",
    "profile_url",
    "rank",
    "target_rank",
    "notes",
    "source_url",
  ].map(normalizedCsvHeader),
);

function retainedCsvEvidenceRow(row: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) =>
        retainedCsvEvidenceHeaders.has(normalizedCsvHeader(key)),
      )
      .map(([key, value]) => [key.slice(0, 200), value.trim().slice(0, 5_000)]),
  );
}

function parseCount(value?: string) {
  if (!value) return null;
  const match = value.match(/\d[\d,]*/);
  if (!match) return null;
  const number = Number(match[0].replaceAll(",", ""));
  return Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000_000
    ? number
    : null;
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
  const headerParse = Papa.parse<string[]>(csv, {
    preview: 1,
    skipEmptyLines: "greedy",
  });
  const headerError = headerParse.errors.find(
    (error) => error.type === "Quotes",
  );
  if (headerError) {
    throw badRequest(
      `The CSV is malformed: ${headerError.message}`,
      "invalid_csv",
    );
  }
  const declaredHeaders = (headerParse.data[0] || []).map((header) =>
    String(header).trim(),
  );
  if (
    !declaredHeaders.length ||
    declaredHeaders.some((header) => !header)
  ) {
    throw badRequest(
      "The CSV must have a non-blank header for every column.",
      "invalid_csv",
    );
  }
  if (new Set(declaredHeaders).size !== declaredHeaders.length) {
    throw badRequest("Every CSV column must have a unique header.", "invalid_csv");
  }
  if (declaredHeaders.length > 200) {
    throw badRequest("A CSV import is limited to 200 columns.", "invalid_csv");
  }
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });
  const structuralError = parsed.errors.find((error) =>
    ["Quotes", "FieldMismatch"].includes(error.type),
  );
  if (structuralError) {
    throw badRequest(
      `The CSV is malformed${typeof structuralError.row === "number" ? ` near row ${structuralError.row + 2}` : ""}: ${structuralError.message}`,
      "invalid_csv",
    );
  }
  const headers = parsed.meta.fields || [];
  if (!headers.length || headers.some((header) => !header)) {
    throw badRequest(
      "The CSV must have a non-blank header for every column.",
      "invalid_csv",
    );
  }
  if (Object.keys(parsed.meta.renamedHeaders || {}).length) {
    throw badRequest("Every CSV column must have a unique header.", "invalid_csv");
  }
  if (!parsed.data.length) {
    throw badRequest("The CSV has a header row but no data.", "invalid_csv");
  }
  if (parsed.data.length > 10_000) {
    throw badRequest(
      "A single CSV import is limited to 10,000 data rows.",
      "invalid_csv",
    );
  }
  const mappedColumns = Object.entries(mapping);
  if (mappedColumns.length) {
    const unknownHeader = mappedColumns.find(
      ([sourceColumn]) => !headers.includes(sourceColumn),
    )?.[0];
    if (unknownHeader) {
      throw badRequest(
        `The CSV mapping refers to an unknown column: ${unknownHeader}.`,
        "invalid_csv_mapping",
      );
    }
    const destinations = mappedColumns
      .map(([, destination]) => destination)
      .filter((destination) => destination !== "ignore");
    if (new Set(destinations).size !== destinations.length) {
      throw badRequest(
        "Each canonical field can be mapped from only one CSV column.",
        "invalid_csv_mapping",
      );
    }
    if (!destinations.includes("company_name")) {
      throw badRequest(
        "Map one CSV column to Company name before importing.",
        "invalid_csv_mapping",
      );
    }
  }
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let contacts = 0;
  const rowWarnings = parsed.errors.map((error) => error.message);
  let omittedWarnings = 0;
  const warnForRow = (rowNumber: number, message: string) => {
    if (rowWarnings.length < 100) {
      rowWarnings.push(`Row ${rowNumber}: ${message}`);
    } else {
      omittedWarnings += 1;
    }
  };
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
      for (const [rowIndex, sourceRow] of parsed.data.entries()) {
      const rowNumber = rowIndex + 2;
      try {
      const row: Record<string, string> = Object.keys(mapping).length
        ? {}
        : { ...sourceRow };
      for (const [sourceColumn, canonicalField] of Object.entries(mapping)) {
        if (canonicalField === "ignore") continue;
        const value = sourceRow[sourceColumn];
        if (value !== undefined && value !== "") row[canonicalField] = value;
      }
      const evidenceRow = retainedCsvEvidenceRow(row);
      const sourceNote = valueFor(row, ["notes"]);
      const sourceUrl = valueFor(row, ["source_url"]) || null;
      const name = valueFor(row, [
        "company_name",
        "company",
        "name",
        "organization",
        "organization_name",
      ]);
      if (!name) {
        skipped++;
        warnForRow(rowNumber, "Company name is missing.");
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
      const companyCandidate = {
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
      } as const;
      const companyParsed = CompanyPatchSchema.extend({
        name: CompanyPatchSchema.shape.name.unwrap(),
      }).safeParse(companyCandidate);
      if (
        !companyParsed.success ||
        (companyParsed.data.employeeCountMin !== null &&
          companyParsed.data.employeeCountMin !== undefined &&
          companyParsed.data.employeeCountMax !== null &&
          companyParsed.data.employeeCountMax !== undefined &&
          companyParsed.data.employeeCountMin > companyParsed.data.employeeCountMax)
      ) {
        skipped++;
        warnForRow(
          rowNumber,
          companyParsed.success
            ? "Minimum employees exceeds maximum employees."
            : companyParsed.error.issues[0]?.message || "Company fields are invalid.",
        );
        continue;
      }
      const company = upsertCompany(companyParsed.data);
      company.inserted ? inserted++ : updated++;
      addEvidence({
        entityType: "company",
        entityId: company.id,
        fieldName: "csv_import",
        value: name,
        sourceType: "csv",
        sourceLabel,
        confidence: 0.5,
        sourceUrl,
        payload: { runId: run.id, row: evidenceRow },
      });
      if (sourceNote) {
        addEvidence({
          entityType: "company",
          entityId: company.id,
          fieldName: "source_note",
          value: sourceNote,
          sourceType: "csv",
          sourceLabel,
          sourceUrl,
          excerpt: sourceNote,
          confidence: 0.5,
          payload: { runId: run.id, rowNumber },
        });
      }

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
        const contactCandidate = {
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
          ...(sourceNote ? { notes: sourceNote } : {}),
        };
        const contactParsed = ContactPatchSchema.extend({
          fullName: ContactPatchSchema.shape.fullName.unwrap(),
        }).safeParse(contactCandidate);
        if (!contactParsed.success) {
          warnForRow(
            rowNumber,
            `Contact skipped: ${contactParsed.error.issues[0]?.message || "invalid contact fields"}.`,
          );
          continue;
        }
        const contact = addContact(company.id, contactParsed.data);
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
            sourceUrl,
            payload: { runId: run.id, row: evidenceRow },
          });
        }
      }
      } catch (error) {
        skipped++;
        warnForRow(
          rowNumber,
          error instanceof Error ? error.message : "The row could not be imported.",
        );
      }
      }
    })();
    const result = {
      runId: run.id,
      inserted,
      updated,
      skipped,
      contacts,
      parseWarnings: [
        ...rowWarnings,
        ...(omittedWarnings
          ? [`${omittedWarnings} additional row warning(s) omitted.`]
          : []),
      ],
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
