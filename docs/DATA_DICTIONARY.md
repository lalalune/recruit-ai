# Data dictionary

Last reviewed: July 28, 2026

RecruitAI stores normalized records in SQLite and exports a flattened contact CSV. A company can have many jobs, people, and evidence items; flattening everything into one giant table would duplicate data and weaken history.

## Identity and time conventions

- IDs are UUID strings and remain stable across edits.
- Timestamps are ISO 8601 UTC.
- Domains are lowercase hostnames without scheme, path, or leading `www`.
- URLs retain `https://` where available.
- Unknown values are `NULL` in SQLite and empty cells in CSV.
- Boolean CSV values are `true` or `false`.
- Multi-value CSV fields use `; ` between values.
- Review status, verification status, and source evidence are separate concepts.

## Company

| Field | Type | Meaning |
|---|---|---|
| `id` | UUID | Stable internal company ID |
| `name` | text | Current canonical company name |
| `normalized_name` | text | Search/dedupe form; not displayed as a source fact |
| `domain` | text/null | Confirmed primary domain |
| `website_url` | URL/null | Canonical public website |
| `linkedin_url` | URL/null | Company page URL pasted by the owner or returned as unconfirmed licensed-provider evidence; RecruitAI never fetches/scrapes it |
| `yc_url` | URL/null | Manually confirmed YC page |
| `description` | text/null | Short company description |
| `location` | text/null | Headquarters or relevant Bay Area location |
| `employee_count_min` | integer/null | Lower bound of current size estimate |
| `employee_count_max` | integer/null | Upper bound of current size estimate |
| `industries` | text[] | Technology-sector tags |
| `stage` | text/null | Publicly supported stage, when useful |
| `status` | enum | `new`, `needs_research`, `ready_for_review`, `approved`, `rejected`, `archived` |
| `priority` | enum | `high`, `medium`, `low` |
| `fit_confirmed` | boolean | Owner confirmed Bay Area, 3–1,000 employee, and technology-scope fit |
| `recruiting_fit` | enum | `unknown`, `likely`, `unlikely`, or `excluded` assessment of likely outside-recruiting need |
| `recruiting_fit_note` | text/null | Evidence or rationale for the recruiting-fit assessment |
| `exclusion_reason` | text/null | Stable company-level exclusion category |
| `exclusion_note` | text/null | Required detail when the category alone is insufficient |
| `notes` | text/null | Owner’s internal notes |
| `reviewed` | boolean | Whether the owner completed the latest record review |
| `hiring_score` | number | Derived queue ordering aid |
| `hiring_score_json` | JSON | Current live-hiring, freshness, fit, outside-help, and evidence score components |
| `open_roles_count` | integer | Active jobs whose latest observation is inside the configured 30–180 day hiring window; default 180 |
| `fresh_roles_count` | integer | Those active jobs observed inside the strong scoring band; currently at most 45 days |
| `conflict_count` | integer | Derived unresolved material conflicts |
| `last_researched_at` | timestamp/null | Last company-level research completion |
| `created_at` | timestamp | Record creation |
| `updated_at` | timestamp | Last canonical-value change |

Aliases retain alternate company names, normalized aliases, and the source that supplied them.

When `autoPrioritizeHiring` is enabled, recomputation promotes a company with at least one current role to `high`; it does not automatically demote an owner-set priority later. Company approval requires current Company fit, Hiring now, Company evidence, Conflicts resolved, and Suppression readiness items. Hiring now requires a company-site, Greenhouse, Lever, Ashby, or owner-confirmed manual role inside both the configured hiring window and refresh target—the stricter age wins; Hacker News is lead-only. Fictional `demo` jobs are accepted solely so the bundled fixture can exercise review. Person/email items can remain incomplete until later, but all readiness items are rechecked before send.

## Contact

| Field | Type | Meaning |
|---|---|---|
| `id` | UUID | Stable person/contact ID |
| `company_id` | UUID | Current company record |
| `first_name` | text/null | Given name when known |
| `last_name` | text/null | Family name when known |
| `full_name` | text | Display name |
| `title` | text/null | Current observed title |
| `role_category` | text/null | Founder, operations, people, talent, functional leader, or other |
| `email` | text/null | Selected email candidate |
| `email_type` | enum | `work`, `personal`, `generic`, `unknown` |
| `fallback_reason` | text/null | Why a personal or generic route is necessary |
| `fallback_confirmed` | boolean | Owner explicitly approved the documented non-work fallback |
| `email_status` | enum | `unverified`, `valid`, `accept_all`, `unknown`, `invalid`, `disposable`, `do_not_mail` |
| `email_verified_at` | timestamp/null | Time represented by the current verification state |
| `phone` | text/null | Manually confirmed number |
| `phone_type` | enum | `business`, `direct`, `mobile`, `switchboard`, `unknown` |
| `phone_confirmed` | boolean | Owner confirmed the number exists |
| `phone_source` | URL/note/null | Required source URL or note when a phone is saved |
| `linkedin_url` | URL/null | Profile URL pasted by the owner or returned as unconfirmed licensed-provider evidence; RecruitAI never fetches/scrapes it |
| `employment_confirmed` | boolean | Owner confirmed the person currently works at this company |
| `observed_title` | text/null | Title actually observed during current-employment confirmation |
| `employment_observed_at` | timestamp/null | Observation date; must be within 180 days for decision-maker/send readiness |
| `rank` | integer | Decision-maker order within the company |
| `status` | enum | `candidate`, `primary`, `alternate`, `invalid`, `left_company`, `suppressed` |
| `reviewed` | boolean | Whether this person/channel was reviewed |
| `notes` | text/null | Owner notes, including fallback rationale |
| `created_at` | timestamp | Record creation |
| `updated_at` | timestamp | Last canonical-value change |

An email verification result does not prove current employment. Evidence for identity/employment and evidence for address deliverability are stored separately.

## Job

| Field | Type | Meaning |
|---|---|---|
| `id` | UUID | Stable internal job ID |
| `company_id` | UUID | Hiring company |
| `external_id` | text/null | Provider’s job ID or deterministic fallback |
| `title` | text | Role title |
| `location` | text/null | Published location |
| `department` | text/null | Published team/department |
| `description_excerpt` | text/null | Bounded evidence excerpt |
| `url` | URL/null | Public job URL |
| `source_type` | text | Adapter identifier such as `company_website`, `hackernews`, `greenhouse`, `lever`, `ashby`, `manual`, or `demo` |
| `posted_at` | timestamp/null | Published time when available; context only, not the current-observation clock |
| `first_seen_at` | timestamp | First RecruitAI observation |
| `last_seen_at` | timestamp | Most recent source refresh observation; used for non-manual freshness |
| `active` | boolean | Present in the latest successful relevant refresh |
| `confirmed_live` | boolean | Manual-source live-role confirmation; supported ATS/company-site sources are intrinsically strong |
| `observed_at` | timestamp/null | Owner observation for a manual job; preferred over `last_seen_at` for manual freshness |

Fresh/stale is derived rather than written into the job. For a manual job, the clock is `observed_at` falling back to `last_seen_at`; for all other sources it is `last_seen_at`. By default, active roles observed inside 180 days count in `open_roles_count`, and observations inside 45 days form the stronger `fresh_roles_count` scoring band. Company approval separately requires at least one company-site/supported-ATS or owner-confirmed manual role observed inside both `jobFreshnessDays` and `jobRefreshDays` (equivalently, the smaller window; defaults 180 and 90), plus company evidence captured inside `maxEvidenceAgeDays` (default 180). A current Hacker News job can affect counts and prioritization but cannot complete Hiring now by itself. Reducing any configured window affects the next recomputation/readiness check; historical jobs/evidence remain stored.

## Evidence

| Field | Type | Meaning |
|---|---|---|
| `id` | UUID | Evidence item |
| `entity_type` | enum | `company`, `contact`, or `job` |
| `entity_id` | UUID | Referenced entity |
| `field_name` | text | Fact being supported or contradicted |
| `value` | text/null | Observed value |
| `source_type` | text | Stable adapter/source name |
| `source_label` | text | Human-readable source |
| `source_url` | URL/null | Public source when available |
| `excerpt` | text/null | Short relevant excerpt |
| `screenshot_path` | path/null | Local snapshot/screenshot reference |
| `confidence` | number | Source adapter estimate from 0–1; never a substitute for review |
| `captured_at` | timestamp | Observation time |
| `payload_json` | JSON/null | Bounded provider/source metadata |

Canonical values can change; evidence remains historical. The current conflict engine derives a conflict when evidence submitted under a supported canonical field name disagrees with the current value, and it separately records ambiguous duplicate-name identities. Broad provider evidence fields remain visible in the trail but do not yet split every embedded size/location/employment discrepancy into separate conflicts automatically.

## Conflict

| Field | Type | Meaning |
|---|---|---|
| `id` | UUID | Stable conflict ID |
| `company_id` | UUID | Company bundle blocked by this conflict |
| `entity_type` | enum | `company`, `contact`, or `job` |
| `entity_id` | UUID | Entity whose field conflicts |
| `field_name` | text | Canonical field or identity relationship in dispute |
| `current_value` | text/null | Current canonical value at conflict creation |
| `candidate_value` | text/null | Contradictory candidate value |
| `evidence_id` | UUID/null | Evidence item that introduced the candidate |
| `status` | enum | `open`, `researching`, or `resolved` |
| `resolution` | enum/null | `keep_current`, `use_candidate`, or `research_further` |
| `resolution_note` | text/null | Owner rationale; required by the UI |
| `created_at` | timestamp | Conflict creation |
| `resolved_at` | timestamp/null | Resolution time |

Open and researching conflicts block company approval and sending. `use_candidate` updates the supported canonical field, `keep_current` preserves it, and `research_further` leaves the issue open and returns the company to Needs research. Every path keeps the evidence and writes audit history.

## Runs, reviews, outreach, suppression, and audit

Source run:

- ID, source type, normalized parameters, and deterministic parameter hash;
- queued/started/finished timestamps;
- `queued`, `running`, `completed`, or `failed`;
- inserted, updated, and skipped counts;
- redacted failure message.

Only one queued/running run with the same source and parameter hash is accepted. Queued-company website research selects non-rejected/non-archived records that have a website/domain and whose `last_researched_at` is absent/older than `jobRefreshDays`, crawls up to three companies concurrently, and can ingest public supported ATS boards detected on first-party pages. If the process restarts, interrupted queued/running rows are marked failed; page-level checkpoint/resume is not implemented.

Review:

- ID, company ID;
- decision: `approved`, `rejected`, or `needs_research`;
- note;
- timestamp.

Outreach draft:

- ID, company ID, contact ID;
- subject and plain-text body;
- manual-edit timestamp, cleared whenever the generated copy is regenerated;
- current states `draft`, `approved`, `sending`, `send_unknown`, `sent`, `replied`, `bounced`, or `no_response`;
- reserved schema/type states `gmail_draft` and `scheduled` are not produced by the current UI;
- scheduled/sent timestamps;
- Gmail message/thread IDs when applicable;
- manual outcome timestamp and optional note;
- created/updated timestamps.

Suppression:

- normalized value;
- kind: email, domain, person, or company;
- reason;
- created time;
- optional source/request reference in a future migration.

Audit event:

- event type, entity type/ID;
- human-readable summary;
- redacted JSON details;
- timestamp.

## Contacts CSV v1

The standard CSV has one row per company/contact pair; a company without contacts still produces one row with empty contact fields. It uses these columns in this order:

| Column | Description |
|---|---|
| `company_id` | Stable company UUID |
| `company_name` | Canonical company name |
| `domain` | Confirmed company domain |
| `website_url` | Canonical company website |
| `location` | Relevant Bay Area location |
| `employee_count_min` | Lower size bound |
| `employee_count_max` | Upper size bound |
| `industries` | Semicolon-delimited technology tags |
| `stage` | Company stage when supported |
| `company_description` | Current canonical short description |
| `fit_confirmed` | Owner’s company-scope confirmation |
| `recruiting_fit` | Unknown/likely/unlikely/excluded outside-recruiting fit |
| `recruiting_fit_note` | Recruiting-fit rationale |
| `exclusion_reason` | Company exclusion category, if any |
| `exclusion_note` | Exclusion detail |
| `hiring_score` | Derived queue-order score |
| `hiring_live_score` | Live-hiring score component, maximum 40 |
| `hiring_freshness_score` | Freshness/repeated-observation component, maximum 20 |
| `company_fit_score` | Bay Area/size/technology/confirmation component, maximum 15 |
| `external_help_score` | Outside-recruiting-fit component, maximum 15 |
| `evidence_quality_score` | Evidence-completeness component, maximum 10 |
| `open_roles_count` | Active jobs observed inside the configured hiring window |
| `fresh_roles_count` | Those jobs observed inside the strong, at-most-45-day band |
| `conflict_count` | Unresolved material conflict count |
| `open_role_titles` | Semicolon-delimited active role titles inside the configured window |
| `open_role_urls` | Semicolon-delimited public role URLs inside the configured window |
| `latest_job_seen_at` | Maximum `last_seen_at` among active jobs inside the configured hiring window |
| `priority` | High, medium, or low |
| `company_status` | Company workflow state |
| `company_reviewed` | Latest company review checkbox |
| `company_linkedin_url` | Stored company page URL; may be manual or unconfirmed provider evidence |
| `yc_url` | Manual YC URL |
| `company_notes` | Internal company notes |
| `last_researched_at` | Company research timestamp |
| `company_suppressed` | Whether a company-ID/name or canonical-domain suppression currently applies |
| `contact_id` | Stable contact UUID |
| `full_name` | Contact name |
| `title` | Current observed title |
| `role_category` | Decision-maker category |
| `email` | Selected email candidate |
| `email_type` | Work, personal, generic, or unknown |
| `fallback_reason` | Reason a personal/generic route is necessary |
| `fallback_confirmed` | Owner confirmation of that fallback |
| `email_status` | Verification/suppression category |
| `email_verified_at` | Verification timestamp |
| `phone` | Manually confirmed phone |
| `phone_type` | Business, direct, mobile, switchboard, or unknown |
| `phone_confirmed` | Explicit phone-existence confirmation |
| `phone_source` | Required phone source URL or note |
| `contact_linkedin_url` | Stored profile URL; may be manual or unconfirmed provider evidence |
| `employment_confirmed` | Owner confirmation of current employment |
| `observed_title` | Title observed during confirmation |
| `employment_observed_at` | Observation date used by the six-month gate |
| `contact_rank` | Decision-maker sequence |
| `contact_status` | Primary/alternate/etc. |
| `contact_reviewed` | Person/channel review checkbox |
| `contact_notes` | Fallback and research notes |
| `contact_suppressed` | Whether person-ID/name or selected-email suppression currently applies |
| `source_labels` | Semicolon-delimited source labels |
| `evidence_count` | Number of supporting company/contact evidence items |
| `evidence_urls` | Semicolon-delimited supporting public URLs |
| `last_outreach_status` | Most recent draft/send lifecycle status |
| `last_outreach_at` | Most recent draft update or send timestamp |

CSV exports quote every cell and use CRLF. Values beginning with spreadsheet formula characters are prefixed safely. The operational CSV includes qualification confirmations, score components, current conflict count, boolean suppression indicators, fallback proof, employment proof, and phone provenance. It still does not contain normalized job/evidence/conflict rows, suppression reasons, immutable audit/review history, provider payloads, settings, or secret material; those remain in SQLite and the full backup.

Putting all normalized job, evidence, conflict, and history rows into this one-row-per-contact CSV would multiply records and make re-import ambiguous. Use **Create backup** for the authoritative full-fidelity export: RecruitAI checkpoints the WAL and creates a versioned JSON artifact containing the SQLite bytes and current top-level snapshot files. Because secrets are stored in SQLite, the artifact also contains saved provider keys and the Gmail refresh token; handle it as a credential-bearing sensitive file. Inspection validates the format/version, safe snapshot names, required tables, and `PRAGMA integrity_check`. Restore creates a pre-restore backup, atomically replaces the database and complete snapshot directory with rollback protection, and reopens the local database without requiring a service restart.

## Import mapping

The CSV screen normalizes case, spaces, punctuation, and underscores when auto-mapping these common headings:

- company: `company`, `company_name`, `organization`, `organization_name`, `name`;
- domain/site: `domain`, `canonical_domain`, `website`, `website_url`, `company_url`;
- geography: `location`, `city`, `headquarters`;
- size: `company_size`, `employee_range`, `employee_count_min`, `employees_min`, `employee_count_max`, `employees_max`, `employees`;
- sector: `industry`, `industries`, `sector`, `tags`;
- person: `full_name`, `contact`, `contact_name`, `person_name`, `first_name`, `last_name`;
- responsibility: `title`, `job_title`, `role`, `role_category`;
- contact: `email`, `work_email`, `primary_email`, `email_type`, `email_kind`, `phone`, `primary_phone`, `phone_type`, `phone_kind`;
- manual phone proof: `phone_confirmed`, `phone_source`, `phone_source_url`;
- manual URLs: `company_linkedin_url`, `linkedin_company`, `person_linkedin_url`, `linkedin_url`, `profile_url`, `yc_url`;
- other: `stage`, `funding_stage`, `description`, `company_description`, `rank`, `target_rank`, `notes`, `source_url`.

Every source column also has an explicit mapping select, so an unrecognized heading can be assigned manually. The source label is a separate import-level field, not a mapped CSV column.

Import is conservative:

- normalize domains and emails;
- dedupe a company primarily by domain;
- never merge people across companies by name alone;
- keep unmapped fields out unless the owner maps them;
- mark all imported records unreviewed;
- do not trust imported “verified” labels without a current supported verifier result and timestamp;
- retain an imported phone only when the row explicitly confirms it and supplies a source URL or note; and
- retain the import filename/label and run ID as provenance.
