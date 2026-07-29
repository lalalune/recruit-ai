import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse/papaparse.min.js";
import type { ParseResult } from "papaparse";
import {
  ArrowUpRight,
  Database,
  FileUp,
  Globe2,
  KeyRound,
  Play,
  Radar,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import {
  Badge,
  Button,
  EmptyState,
  InlineNotice,
  Input,
  Spinner,
} from "../components/ui";
import { api } from "../lib/api";
import { Link } from "../lib/router";

type DiscoveryMode = "public" | "job_board" | "csv";

const sourceDescriptions = {
  datasf: {
    title: "DataSF technology businesses",
    body: "Seed San Francisco registrations, then resolve domains and hiring evidence.",
  },
  hackernews: {
    title: "Hacker News hiring signals",
    body: "Find Bay Area companies in the latest Who Is Hiring thread. Contact details are not harvested.",
  },
  apollo: {
    title: "Apollo companies with open roles",
    body: "Search licensed firmographic and hiring data. Requires a configured master API key.",
  },
  brave_domains: {
    title: "Resolve missing company domains",
    body: "Use Brave Search to find likely official websites for records already in the queue.",
  },
  company_websites: {
    title: "Research queued company websites",
    body: "Crawl bounded public company pages, detect careers links and supported job boards, and retain source snapshots.",
  },
};

const csvCanonicalFields = [
  ["ignore", "Ignore"],
  ["company_name", "Company name"],
  ["domain", "Domain"],
  ["website_url", "Website"],
  ["location", "Location"],
  ["company_size", "Company size/range"],
  ["employee_count_min", "Minimum employees"],
  ["employee_count_max", "Maximum employees"],
  ["industries", "Industries"],
  ["stage", "Stage"],
  ["description", "Description"],
  ["company_linkedin_url", "Company profile URL"],
  ["yc_url", "YC URL"],
  ["full_name", "Contact name"],
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["title", "Title"],
  ["role_category", "Role category"],
  ["email", "Email"],
  ["email_type", "Email type"],
  ["phone", "Phone"],
  ["phone_type", "Phone type"],
  ["phone_confirmed", "Phone confirmed"],
  ["phone_source", "Phone source"],
  ["person_linkedin_url", "Person profile URL"],
  ["rank", "Contact rank"],
  ["notes", "Notes"],
  ["source_url", "Source URL"],
] as const;

const csvAliases: Record<string, string> = {
  company: "company_name",
  companyname: "company_name",
  organization: "company_name",
  organizationname: "company_name",
  name: "company_name",
  domain: "domain",
  canonicaldomain: "domain",
  website: "website_url",
  websiteurl: "website_url",
  companyurl: "website_url",
  location: "location",
  city: "location",
  headquarters: "location",
  companysize: "company_size",
  employeerange: "company_size",
  employeecountmin: "employee_count_min",
  employeesmin: "employee_count_min",
  employeecountmax: "employee_count_max",
  employeesmax: "employee_count_max",
  employees: "employee_count_max",
  industry: "industries",
  industries: "industries",
  sector: "industries",
  tags: "industries",
  stage: "stage",
  fundingstage: "stage",
  description: "description",
  companydescription: "description",
  companylinkedinurl: "company_linkedin_url",
  linkedincompany: "company_linkedin_url",
  ycurl: "yc_url",
  fullname: "full_name",
  contact: "full_name",
  contactname: "full_name",
  personname: "full_name",
  firstname: "first_name",
  lastname: "last_name",
  title: "title",
  jobtitle: "title",
  role: "title",
  rolecategory: "role_category",
  email: "email",
  workemail: "email",
  primaryemail: "email",
  emailtype: "email_type",
  emailkind: "email_type",
  phone: "phone",
  primaryphone: "phone",
  phonetype: "phone_type",
  phonekind: "phone_type",
  phoneconfirmed: "phone_confirmed",
  phonesource: "phone_source",
  phonesourceurl: "phone_source",
  personlinkedinurl: "person_linkedin_url",
  linkedinurl: "person_linkedin_url",
  profileurl: "person_linkedin_url",
  rank: "rank",
  targetrank: "rank",
  notes: "notes",
  sourceurl: "source_url",
};

function autoCsvMapping(headers: string[]) {
  const used = new Set<string>();
  return Object.fromEntries(
    headers.map((header) => {
      const normalized = header.toLowerCase().replace(/[^a-z0-9]/g, "");
      const candidate = csvAliases[normalized] || "ignore";
      if (candidate !== "ignore" && used.has(candidate)) return [header, "ignore"];
      if (candidate !== "ignore") used.add(candidate);
      return [header, candidate];
    }),
  );
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function DiscoverPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<DiscoveryMode>("public");
  const [source, setSource] = useState<keyof typeof sourceDescriptions>("datasf");
  const [limit, setLimit] = useState(500);
  const [technologyOnly, setTechnologyOnly] = useState(true);
  const [autoApplyDomains, setAutoApplyDomains] = useState(false);
  const [provider, setProvider] = useState("greenhouse");
  const [identifier, setIdentifier] = useState("");
  const [jobCompanyId, setJobCompanyId] = useState("");
  const [csv, setCsv] = useState("");
  const [sourceLabel, setSourceLabel] = useState("Manual CSV import");
  const [csvFileName, setCsvFileName] = useState("");
  const [csvFileSize, setCsvFileSize] = useState(0);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvPreview, setCsvPreview] = useState<Array<Record<string, string>>>([]);
  const [csvRowCount, setCsvRowCount] = useState(0);
  const [csvMapping, setCsvMapping] = useState<Record<string, string>>({});
  const [csvError, setCsvError] = useState("");
  const [csvParsing, setCsvParsing] = useState(false);
  const [importResult, setImportResult] = useState<{
    inserted: number;
    updated: number;
    skipped: number;
    contacts: number;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const csvParseSequence = useRef(0);
  const defaultsApplied = useRef(false);

  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: api.dashboard,
  });
  const runs = useQuery({
    queryKey: ["source-runs"],
    queryFn: api.sourceRuns,
    refetchInterval: (query) =>
      query.state.data?.some((run) =>
        ["queued", "running"].includes(run.status),
      )
        ? 2_000
        : false,
  });
  const policies = useQuery({
    queryKey: ["source-policies"],
    queryFn: api.sourcePolicies,
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings,
  });
  const jobCompanies = useQuery({
    enabled: mode === "job_board",
    queryKey: ["companies", "job-board-picker"],
    queryFn: () =>
      api.companies(
        new URLSearchParams({ limit: "200", sort: "name" }),
      ),
  });
  const hasRunning = runs.data?.some((run) =>
    ["queued", "running"].includes(run.status),
  );

  useEffect(() => {
    if (!settings.data || defaultsApplied.current) return;
    defaultsApplied.current = true;
    if (typeof settings.data.values.technologyOnlyDataSf === "boolean") {
      setTechnologyOnly(settings.data.values.technologyOnlyDataSf);
    }
  }, [settings.data]);

  const runMutation = useMutation({
    mutationFn: async () => {
      if (mode === "public") {
        return api.runDiscovery({
          source,
          limit,
          ...(source === "datasf" ? { technologyOnly } : {}),
          ...(source === "brave_domains"
            ? { autoApplyHighConfidence: autoApplyDomains }
            : {}),
        });
      }
      if (mode === "job_board") {
        return api.runDiscovery({
          source: "job_board",
          provider,
          identifier,
          ...(jobCompanyId ? { companyId: jobCompanyId } : {}),
        });
      }
      return api.importCsv(csv, sourceLabel, csvMapping);
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["source-runs"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["companies"] }),
      ]);
      if (
        result &&
        typeof result === "object" &&
        "inserted" in result &&
        typeof result.inserted === "number" &&
        "updated" in result &&
        typeof result.updated === "number" &&
        "skipped" in result &&
        typeof result.skipped === "number" &&
        "contacts" in result &&
        typeof result.contacts === "number"
      ) {
        setImportResult({
          inserted: result.inserted,
          updated: result.updated,
          skipped: result.skipped,
          contacts: result.contacts,
        });
      }
    },
  });

  const demoMutation = useMutation({
    mutationFn: api.loadDemo,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["companies"] }),
      ]);
    },
  });

  const metrics = useMemo(
    () => [
      ["Companies", dashboard.data?.companies ?? (dashboard.isLoading ? "…" : "—")],
      ["Open roles", dashboard.data?.openRoles ?? (dashboard.isLoading ? "…" : "—")],
      ["Needs review", dashboard.data?.needsReview ?? (dashboard.isLoading ? "…" : "—")],
      ["Valid emails", dashboard.data?.validEmails ?? (dashboard.isLoading ? "…" : "—")],
    ],
    [dashboard.data, dashboard.isLoading],
  );

  function clearCsvSelection(resetInput = true) {
    setCsv("");
    setCsvFileName("");
    setCsvFileSize(0);
    setCsvHeaders([]);
    setCsvPreview([]);
    setCsvRowCount(0);
    setCsvMapping({});
    setImportResult(null);
    if (resetInput && fileInput.current) fileInput.current.value = "";
  }

  function parseCsvFile(file: File) {
    return new Promise<ParseResult<Record<string, string>>>((resolve, reject) => {
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: "greedy",
        worker: true,
        complete: resolve,
        error: reject,
      });
    });
  }

  async function handleFile(file?: File) {
    if (!file) return;
    const sequence = ++csvParseSequence.current;
    setCsvError("");
    clearCsvSelection(false);
    if (file.size > 20 * 1024 * 1024) {
      setCsvError("Choose a CSV no larger than 20 MB.");
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setCsvParsing(true);
    try {
      const [text, parsed] = await Promise.all([file.text(), parseCsvFile(file)]);
      if (sequence !== csvParseSequence.current) return;
      const rawHeaders = parsed.meta.fields || [];
      const headers = rawHeaders.map((header) => header.trim());
      const structuralError = parsed.errors.find((error) =>
        ["Quotes", "FieldMismatch"].includes(error.type),
      );
      if (structuralError) {
        setCsvError(
          `The CSV is malformed${typeof structuralError.row === "number" ? ` near row ${structuralError.row + 2}` : ""}: ${structuralError.message}`,
        );
        if (fileInput.current) fileInput.current.value = "";
        return;
      }
      if (parsed.meta.renamedHeaders) {
        setCsvError("Every CSV column must have a unique header.");
        if (fileInput.current) fileInput.current.value = "";
        return;
      }
      if (!headers.length || headers.some((header) => !header)) {
        setCsvError("The CSV must have a non-blank header for every column.");
        if (fileInput.current) fileInput.current.value = "";
        return;
      }
      if (new Set(headers).size !== headers.length) {
        setCsvError("Every CSV column must have a unique header.");
        if (fileInput.current) fileInput.current.value = "";
        return;
      }
      if (headers.length > 200) {
        setCsvError("A CSV import is limited to 200 columns.");
        if (fileInput.current) fileInput.current.value = "";
        return;
      }
      if (!parsed.data.length) {
        setCsvError("The CSV has a header row but no data.");
        if (fileInput.current) fileInput.current.value = "";
        return;
      }
      if (parsed.data.length > 10_000) {
        setCsvError("A single CSV import is limited to 10,000 data rows.");
        if (fileInput.current) fileInput.current.value = "";
        return;
      }
      setCsv(text);
      setCsvFileName(file.name);
      setCsvFileSize(file.size);
      setSourceLabel(file.name.replace(/\.csv$/i, "") || "CSV import");
      setCsvHeaders(headers);
      setCsvPreview(
        parsed.data.slice(0, 5).map((row) =>
          Object.fromEntries(
            rawHeaders.map((header, index) => [
              headers[index],
              row[header] ?? "",
            ]),
          ),
        ),
      );
      setCsvRowCount(parsed.data.length);
      setCsvMapping(autoCsvMapping(headers));
    } catch (error) {
      if (sequence !== csvParseSequence.current) return;
      setCsvError(
        error instanceof Error ? error.message : "The CSV could not be read.",
      );
      if (fileInput.current) fileInput.current.value = "";
    } finally {
      if (sequence === csvParseSequence.current) setCsvParsing(false);
    }
  }

  const disabled =
    runMutation.isPending ||
    csvParsing ||
    hasRunning ||
    (mode === "job_board" && !identifier.trim()) ||
    (mode === "csv" &&
      (!csv.trim() || !Object.values(csvMapping).includes("company_name")));
  const normalizedBoardIdentifier = useMemo(() => {
    const value = identifier.trim();
    if (!value) return "";
    try {
      const url = new URL(value);
      return url.pathname.split("/").filter(Boolean)[0] || "";
    } catch {
      return value.split(/[/?#]/)[0];
    }
  }, [identifier]);

  return (
    <div className="page">
      <PageHeader
        title="Discover"
        description="Build the company universe from permitted public sources and licensed providers."
        actions={
          <a className="button button--secondary" href="/api/export/contacts.csv">
            Export CSV
          </a>
        }
      />

      <section className="metric-strip" aria-label="Workspace totals">
        {metrics.map(([label, value]) => (
          <div className="metric-strip__item" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </section>

      {dashboard.error ? (
        <InlineNotice tone="danger">
          Workspace totals could not be loaded: {dashboard.error.message}
        </InlineNotice>
      ) : null}

      {hasRunning ? (
        <InlineNotice tone="info">
          <span>
            <strong>Research is running.</strong> Results are idempotently merged into
            the review queue.
          </span>
          <Spinner label="Working" />
        </InlineNotice>
      ) : null}

      {demoMutation.error ? (
        <InlineNotice tone="danger">
          Demo records could not be loaded: {demoMutation.error.message}
        </InlineNotice>
      ) : null}

      <div className="discover-layout">
        <section className="panel">
          <div className="panel__heading">
            <div>
              <h2>Start research</h2>
              <p>Choose one route. Existing records are updated instead of duplicated.</p>
            </div>
          </div>

          <div className="segmented-control" aria-label="Discovery route">
            {[
              ["public", "Source"],
              ["job_board", "Job board"],
              ["csv", "Import CSV"],
            ].map(([value, label]) => (
              <button
                aria-pressed={mode === value}
                className={mode === value ? "is-selected" : ""}
                key={value}
                onClick={() => setMode(value as DiscoveryMode)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "public" ? (
            <div className="form-stack">
              <fieldset className="source-options">
                <legend>Source</legend>
                {Object.entries(sourceDescriptions).map(([value, detail]) => (
                  <label
                    className={`source-option ${source === value ? "is-selected" : ""}`}
                    key={value}
                  >
                    <input
                      checked={source === value}
                      name="source"
                      onChange={() =>
                        setSource(value as keyof typeof sourceDescriptions)
                      }
                      type="radio"
                    />
                    <span className="source-option__icon">
                      {value === "datasf" ? (
                        <Database size={18} />
                      ) : value === "apollo" ? (
                        <KeyRound size={18} />
                      ) : value === "brave_domains" ||
                        value === "company_websites" ? (
                        <Globe2 size={18} />
                      ) : (
                        <Radar size={18} />
                      )}
                    </span>
                    <span>
                      <strong>{detail.title}</strong>
                      <small>{detail.body}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <label className="field">
                <span>Maximum companies</span>
                <Input
                  max={source === "hackernews" ? 500 : 10_000}
                  min={1}
                  onChange={(event) => setLimit(Number(event.target.value))}
                  type="number"
                  value={limit}
                />
                <small>Start with 200–500 to measure coverage before a full run.</small>
              </label>
              {source === "datasf" ? (
                <label className="native-checkbox">
                  <input
                    checked={technologyOnly}
                    onChange={(event) => setTechnologyOnly(event.target.checked)}
                    type="checkbox"
                  />
                  Restrict to technology-related NAICS codes
                </label>
              ) : null}
              {source === "brave_domains" ? (
                <label className="native-checkbox">
                  <input
                    checked={autoApplyDomains}
                    onChange={(event) => setAutoApplyDomains(event.target.checked)}
                    type="checkbox"
                  />
                  Apply only high-confidence exact-name domains automatically
                </label>
              ) : null}
            </div>
          ) : null}

          {mode === "job_board" ? (
            <div className="form-stack">
              <label className="field">
                <span>Provider</span>
                <select
                  className="select"
                  onChange={(event) => setProvider(event.target.value)}
                  value={provider}
                >
                  <option value="greenhouse">Greenhouse</option>
                  <option value="lever">Lever</option>
                  <option value="ashby">Ashby</option>
                </select>
              </label>
              <label className="field">
                <span>Board name or public job-board URL</span>
                <Input
                  onChange={(event) => setIdentifier(event.target.value)}
                  placeholder={
                    provider === "greenhouse"
                      ? "company or https://boards.greenhouse.io/company"
                      : provider === "lever"
                        ? "company or https://jobs.lever.co/company"
                        : "company or https://jobs.ashbyhq.com/company"
                  }
                  value={identifier}
                />
                <small>Only published/listed jobs are collected.</small>
                {normalizedBoardIdentifier ? (
                  <small>
                    Normalized identifier: <code>{normalizedBoardIdentifier}</code>
                  </small>
                ) : null}
              </label>
              <label className="field">
                <span>Attach to existing company (optional)</span>
                <select
                  className="select"
                  onChange={(event) => setJobCompanyId(event.target.value)}
                  value={jobCompanyId}
                >
                  <option value="">Match or create from the board</option>
                  {jobCompanies.data?.data.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
                <small>
                  Choose a company when the board slug differs from its common name.
                </small>
              </label>
            </div>
          ) : null}

          {mode === "csv" ? (
            <div className="form-stack">
              <input
                accept=".csv,text/csv"
                className="visually-hidden"
                onChange={(event) => handleFile(event.target.files?.[0])}
                ref={fileInput}
                type="file"
              />
              <button
                className="file-drop"
                disabled={csvParsing}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  handleFile(event.dataTransfer.files[0]);
                }}
                onClick={() => fileInput.current?.click()}
                type="button"
              >
                <FileUp size={22} />
                <span>
                  <strong>
                    {csvParsing
                      ? "Reading CSV…"
                      : csv
                        ? sourceLabel
                        : "Choose or drop a CSV file"}
                  </strong>
                  <small>
                    {csv
                      ? `${csvFileName} · ${(csvFileSize / 1024).toFixed(1)} KB · ${csvRowCount} rows`
                      : "Recognizes common company, contact, email, phone, and source column names."}
                  </small>
                </span>
              </button>
              {csv ? (
                <Button
                  onClick={() => {
                    ++csvParseSequence.current;
                    setCsvParsing(false);
                    setCsvError("");
                    clearCsvSelection();
                  }}
                  variant="ghost"
                >
                  Remove selected file
                </Button>
              ) : null}
              <label className="field">
                <span>Source label</span>
                <Input
                  onChange={(event) => setSourceLabel(event.target.value)}
                  value={sourceLabel}
                />
              </label>
              {csvHeaders.length ? (
                <>
                  <div className="csv-mapping">
                    <div className="panel__heading">
                      <div>
                        <h3>Column mapping</h3>
                        <p>
                          Common headers are mapped automatically. One source
                          column can fill one canonical field.
                        </p>
                      </div>
                    </div>
                    {csvHeaders.map((header) => {
                      const used = new Set(
                        Object.entries(csvMapping)
                          .filter(([source]) => source !== header)
                          .map(([, value]) => value)
                          .filter((value) => value !== "ignore"),
                      );
                      return (
                        <label className="csv-mapping__row" key={header}>
                          <span>{header}</span>
                          <select
                            className="select select--compact"
                            onChange={(event) =>
                              setCsvMapping((current) => ({
                                ...current,
                                [header]: event.target.value,
                              }))
                            }
                            value={csvMapping[header] || "ignore"}
                          >
                            {csvCanonicalFields.map(([value, label]) => (
                              <option
                                disabled={value !== "ignore" && used.has(value)}
                                key={value}
                                value={value}
                              >
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                  <div className="csv-preview">
                    <strong>First {Math.min(5, csvPreview.length)} rows</strong>
                    <div className="csv-preview__scroll">
                      <table>
                        <thead>
                          <tr>
                            {csvHeaders.map((header) => (
                              <th key={header} scope="col">
                                {header}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {csvPreview.map((row, index) => (
                            <tr key={index}>
                              {csvHeaders.map((header) => (
                                <td key={header}>{row[header] || ""}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {csvError ? <InlineNotice tone="danger">{csvError}</InlineNotice> : null}
          {importResult ? (
            <InlineNotice tone="success">
              Import complete: {importResult.inserted} companies added,{" "}
              {importResult.updated} updated, {importResult.contacts} contacts
              retained, and {importResult.skipped} rows skipped.
            </InlineNotice>
          ) : null}
          {runMutation.error ? (
            <InlineNotice tone="danger">{runMutation.error.message}</InlineNotice>
          ) : null}
          <div className="form-actions">
            <Button
              disabled={disabled}
              onClick={() => runMutation.mutate()}
              variant="primary"
            >
              <Play size={16} fill="currentColor" />
              {mode === "csv"
                ? `Import ${csvRowCount || ""} records`
                : "Start research"}
            </Button>
            <span className="form-hint">No outreach is sent by research runs.</span>
          </div>
        </section>

        <aside className="panel panel--subtle">
          <div className="panel__heading">
            <div>
              <h2>Source policy</h2>
              <p>What the app automates and what stays manual.</p>
            </div>
          </div>
          <div className="policy-list">
            {policies.isLoading ? (
              <Spinner label="Loading source policy" />
            ) : policies.error ? (
              <InlineNotice tone="danger">
                Source policy could not be loaded: {policies.error.message}
              </InlineNotice>
            ) : (
              policies.data?.map((policy) => (
                <div className="policy-row" key={policy.id}>
                  <div>
                    <strong>{policy.name}</strong>
                    <p>{policy.detail}</p>
                  </div>
                  <Badge
                    tone={
                      policy.mode === "automatic"
                        ? "success"
                        : policy.mode === "signal_only"
                          ? "info"
                          : "warning"
                    }
                  >
                    {policy.mode === "signal_only"
                      ? "Signal only"
                      : policy.mode === "manual"
                        ? "Manual"
                        : "Automatic"}
                  </Badge>
                </div>
              ))
            )}
          </div>
          <div className="external-research-links">
            <a
              href="https://www.ycombinator.com/companies/location/san-francisco-bay-area/hiring"
              rel="noreferrer"
              target="_blank"
            >
              Open YC hiring directory <ArrowUpRight size={14} />
            </a>
            <a
              href="https://www.linkedin.com/search/results/companies/?keywords=San%20Francisco%20startup"
              rel="noreferrer"
              target="_blank"
            >
              Open LinkedIn manually <ArrowUpRight size={14} />
            </a>
          </div>
        </aside>
      </div>

      <section className="panel">
        <div className="panel__heading panel__heading--row">
          <div>
            <h2>Recent activity</h2>
            <p>Runs continue in the local process and remain visible after refresh.</p>
          </div>
          <Link className="text-link" to="/review">
            Open review queue <ArrowUpRight size={14} />
          </Link>
        </div>
        {runs.error ? (
          <InlineNotice tone="danger">
            Recent research activity could not be loaded: {runs.error.message}
          </InlineNotice>
        ) : runs.isLoading ? (
          <Spinner label="Loading activity" />
        ) : runs.data?.length ? (
          <div
            aria-label="Recent research activity"
            className="activity-table"
            role="table"
          >
            <div className="activity-table__header" role="row">
              <span role="columnheader">Source</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Added</span>
              <span role="columnheader">Updated</span>
              <span role="columnheader">Finished</span>
            </div>
            {runs.data.map((run) => (
              <div className="activity-table__row" key={run.id} role="row">
                <span className="activity-source" role="cell">
                  <Globe2 aria-hidden="true" size={15} />
                  {run.sourceType}
                </span>
                <span role="cell">
                  <Badge
                    tone={
                      run.status === "completed"
                        ? "success"
                        : run.status === "failed"
                          ? "danger"
                          : "info"
                    }
                  >
                    {run.status}
                  </Badge>
                  {run.errorMessage ? (
                    <small className="row-error">{run.errorMessage}</small>
                  ) : null}
                </span>
                <span role="cell">{run.insertedCount}</span>
                <span role="cell">{run.updatedCount}</span>
                <span role="cell">{formatDate(run.finishedAt || run.createdAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            action={
              <Button
                disabled={demoMutation.isPending}
                onClick={() => demoMutation.mutate()}
              >
                Load fictional demo records
              </Button>
            }
            body="Run a source above, import a CSV, or load three fictional companies to explore the review workflow."
            title="No research runs yet"
          />
        )}
      </section>
    </div>
  );
}
