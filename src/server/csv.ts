import Papa from "papaparse";
import { exportRows } from "./repository";

const columns = [
  "company_id",
  "company_name",
  "domain",
  "website_url",
  "location",
  "employee_count_min",
  "employee_count_max",
  "industries",
  "stage",
  "company_description",
  "fit_confirmed",
  "recruiting_fit",
  "recruiting_fit_note",
  "exclusion_reason",
  "exclusion_note",
  "hiring_score",
  "hiring_live_score",
  "hiring_freshness_score",
  "company_fit_score",
  "external_help_score",
  "evidence_quality_score",
  "open_roles_count",
  "fresh_roles_count",
  "conflict_count",
  "open_role_titles",
  "open_role_urls",
  "latest_job_seen_at",
  "priority",
  "company_status",
  "company_reviewed",
  "company_linkedin_url",
  "yc_url",
  "company_notes",
  "last_researched_at",
  "company_suppressed",
  "contact_id",
  "full_name",
  "title",
  "role_category",
  "email",
  "email_type",
  "fallback_reason",
  "fallback_confirmed",
  "email_status",
  "email_verified_at",
  "phone",
  "phone_type",
  "phone_confirmed",
  "phone_source",
  "contact_linkedin_url",
  "employment_confirmed",
  "observed_title",
  "employment_observed_at",
  "contact_rank",
  "contact_status",
  "contact_reviewed",
  "contact_notes",
  "contact_suppressed",
  "source_labels",
  "evidence_count",
  "evidence_urls",
  "last_outreach_status",
  "last_outreach_at",
] as const;

const booleanColumns = new Set<(typeof columns)[number]>([
  "fit_confirmed",
  "company_reviewed",
  "company_suppressed",
  "fallback_confirmed",
  "phone_confirmed",
  "employment_confirmed",
  "contact_reviewed",
  "contact_suppressed",
]);

function neutralizeFormula(value: unknown) {
  if (typeof value !== "string") return value;
  return /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
}

export function createContactsCsv() {
  const rows = exportRows().map((row) => {
    const output: Record<string, unknown> = {};
    for (const column of columns) {
      const value =
        column === "industries"
          ? (() => {
              try {
                return JSON.parse(String(row.industries_json || "[]")).join("; ");
              } catch {
                return "";
              }
            })()
          : booleanColumns.has(column)
            ? row[column] === null || row[column] === undefined
              ? ""
              : Boolean(row[column])
                ? "true"
                : "false"
            : row[column];
      output[column] = neutralizeFormula(value ?? "");
    }
    return output;
  });
  return Papa.unparse(rows, {
    columns: [...columns],
    newline: "\r\n",
    quotes: true,
  });
}
