# Research and implementation plan

Last reviewed: July 28, 2026

This document is the implementation brief for RecruitAI: a local-first research workspace for finding San Francisco Bay Area technology startups with current hiring needs, identifying the best hiring decision-maker, verifying one contact route, and preparing individually reviewed outreach.

It is a product and engineering plan, not legal advice. Laws, provider terms, prices, API fields, and sending limits can change. Re-check the linked primary sources before enabling a provider or beginning outreach.

### Implementation status

The local research, review, draft, explicit Gmail-send, manual-outcome, CSV, and full backup/restore paths described below are implemented. Where this document says **target refinement**, the capability is intentionally planned rather than present. In particular, there is no authenticated browser scraper, JavaScript browser fallback, unattended send queue, Gmail inbox reader, automated reply/bounce detection, run checkpoint/resume, packaged auto-updater, or OS-keychain integration.

## 1. Outcome and operating rules

The target dataset is up to 10,000 qualified companies, not 10,000 unfiltered directory entries.

A qualified company should:

- be based in, or have a meaningful hiring presence in, the San Francisco Bay Area;
- have approximately 3–1,000 employees;
- operate in AI, ML, data, robotics, hardware, manufacturing, research, or another high-technology field;
- show a current need to hire one or more technical, research, operations, manufacturing, or executive roles;
- appear plausibly open to outside contingency recruiting rather than having a large, mature internal recruiting operation or a known exclusive recruiting arrangement;
- have evidence supporting the company identity, hiring signal, and selected decision-maker;
- have one primary contact selected for the current outreach round, with alternates retained but not contacted concurrently; and
- pass a human review before export or outreach.

The commercial proposition is a contingency search agreement at 30% of first-year salary, due only when the company hires a referred candidate. Drafts should state that plainly and should be tailored to the company’s size, technology, open roles, and likely recruiting owner.

Primary work emails are preferred. A personal or generic email is a fallback only when no work route is available, the owner confirms the reason, and the address separately verifies `valid`. Catch-all/accept-all and unknown results stay research-only and cannot satisfy send readiness. Phone collection is manual only.

“Hiring now” is an evidence-backed state, not an inference from company size or funding alone. The default freshness policy is:

- an active job whose latest RecruitAI observation is inside the configured 30–180 day hiring window counts as current; the default is 180 days. Manual jobs use `observed_at` falling back to `last_seen_at`; automatic sources use `last_seen_at`;
- the most recent 45 observation-days are the strong `fresh_roles_count` scoring band;
- a role observed 46–180 days ago can still contribute to current/open counts at the default setting, but company approval separately requires at least one company-site, supported-ATS, or owner-confirmed manual role inside both `jobFreshnessDays` and `jobRefreshDays` (the smaller window wins; defaults 180 and 90); Hacker News remains lead-only until confirmed;
- company approval also requires at least one company evidence item captured inside `maxEvidenceAgeDays`, default 180;
- evidence outside those respective windows remains in history but blocks the affected readiness item until refreshed;
- decision-maker employment confirmation requires a reviewed primary, observed title, and observation no more than 180 days old; and
- email verification must report `valid` within the configured 1–30 day period at send time; the default is 30 days.

The owner can change the hiring, refresh, evidence, and email windows. Saving them recomputes company statistics; company approval and Gmail send recheck the separate hiring-observation and evidence-age gates. Historical rows remain retained even when derived readiness expires.

## 2. Non-negotiable boundaries

### LinkedIn

RecruitAI does not log in to LinkedIn, import LinkedIn cookies, reuse a browser profile, automate authenticated pages, or scrape profiles. LinkedIn’s [User Agreement](https://www.linkedin.com/legal/user-agreement) prohibits scraping and the use of copied cookies or other methods to bypass access controls. LinkedIn’s official [Profile API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api) is restricted and is not a general-purpose people-search API.

Direct LinkedIn access is manual: RecruitAI opens a public search or saved profile URL, the owner confirms the person and current employment, and RecruitAI stores the URL, observation, timestamp, and optional local evidence note. A licensed provider such as Apollo may separately return a LinkedIn URL inside its payload; RecruitAI stores it as provider evidence but does not fetch it or treat it as owner confirmation. No LinkedIn credential or cookie field exists in the product.

### Commercial email

Describing a message as personal, one-time, or B2B does not remove commercial-email obligations. The FTC’s [CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) says the law applies to commercial email, including B2B email, and requires accurate headers and subject lines, a valid physical postal address, a clear opt-out method, and timely honoring of opt-outs.

Accordingly, Gmail sending must remain locked until all of the following are complete:

1. sender name and authenticated sending address;
2. valid postal address;
3. editable opt-out text and a working suppression process;
4. truthful subject and sender fields;
5. explicit human approval of the company, person, email, subject, and body;
6. a fresh email verification result;
7. hourly and daily limits;
8. suppression checks immediately before send; and
9. a successful Gmail self-test sent to the connected account after the current connection and identity setup; and
10. an auditable send result.

Draft generation, editing, and export can be used before the gate is complete. There is no “ignore compliance” override.

### Personal information

Professional identity and contact information can still be personal information. California’s statutory definition expressly includes professional or employment-related information; see [California Civil Code § 1798.140](https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?division=3.&lawCode=CIV&part=4.&title=1.81.5). Whether the operator is subject to the CCPA and what notices or rights apply depends on facts outside this repository.

The application therefore minimizes collection, records source and purpose, supports correction/suppression, does not publish the database, and keeps the dataset local. “Retain forever” is implemented as retained history with visible freshness and suppression states, not as permission to ignore a valid deletion or opt-out request.

Do not infer a person’s political beliefs or other sensitive traits. If the owner excludes a company because its publicly stated organizational mission is primarily political or advocacy-oriented, that is a manually reviewed company-level classification, never a person-level inference.

## 3. Acquisition strategy: three routes

### Route A — browser-first

Run a persistent browser, log in to directories and social platforms, and extract rendered content.

Advantages:

- handles JavaScript-heavy sites;
- resembles the owner’s manual workflow; and
- can capture visual evidence.

Disadvantages:

- fragile selectors and frequent breakage;
- difficult rate limiting and replay;
- high legal and terms-of-service risk on authenticated sites;
- dangerous credential and cookie handling;
- poor idempotency; and
- expensive at 10,000-company scale.

Decision: not the foundation. A browser may later be used for permitted public pages or visual confirmation, in an isolated profile, but never as a mechanism for authenticated LinkedIn scraping or access-control evasion.

### Route B — provider-first

Use licensed company/people enrichment, job-board, and verification APIs for nearly every field.

Advantages:

- fastest initial coverage;
- structured payloads and provider-supported pagination;
- predictable retry behavior; and
- less parser maintenance.

Disadvantages:

- cost and credit uncertainty;
- provider coverage and freshness are not proof;
- licensing and permitted-use constraints;
- vendor lock-in; and
- opaque confidence labels.

Decision: useful for contact enrichment, not sufficient by itself. Every material fact still needs a source timestamp, and provider output stays reviewable.

### Route C — hybrid evidence pipeline

Seed companies from permitted public data and licensed APIs, detect hiring from public ATS/careers sources, research company-owned pages, enrich only the best decision-maker, verify only the selected address, and place the record in a human review queue.

Advantages:

- best balance of coverage, cost, evidence quality, and maintainability;
- API credits are spent after qualification;
- public sources remain inspectable;
- idempotent runs and conflict handling are practical; and
- risky or prohibited sources can remain manual.

Disadvantages:

- more orchestration than a single-provider import;
- some companies require manual research; and
- source-specific adapters still need maintenance.

Decision: use Route C. The pipeline is:

`discover → normalize/dedupe → qualify hiring → research company → rank people → enrich one person → verify email → resolve conflicts → review → draft → approve → optional Gmail send`

## 4. Source-policy matrix

“Automatic” means the source may be called by a background run. “Signal only” means it can establish that hiring may be happening, but RecruitAI does not collect contact information from it. “Manual” means the product may open a link and record an owner-confirmed observation. “Disabled” means no integration is shipped until the stated condition is satisfied.

| Source | Mode | Purpose | Data kept | Strengths | Limits and policy |
|---|---|---|---|---|---|
| Company-owned websites | Automatic | Domain, description, careers/team/contact pages, published mailto links, JSON-LD jobs, detected supported ATS boards | URL, excerpt, timestamp, content hash, local HTML snapshot, extracted facts and public ATS jobs | First-party, inspectable, free | Queued-company batches crawl at most three companies concurrently. The bounded HTTP parser uses same-origin public HTTP(S), validates every redirect and DNS answer, pins a validated public address to the outbound socket, applies `robots.txt` rules and page/byte/time caps, has no login/browser fallback, and blocks private/link-local/reserved destinations. Detected Greenhouse/Lever/Ashby links are refreshed through their public APIs. A possible out-of-scope mission only creates a review flag; it never auto-excludes. Published email is still unverified |
| Greenhouse Job Board API | Automatic | Current jobs for a known board token | Job identity, title, location, department, URL, observed times | Public structured feed, free | Board token must be known; a listed job can still be stale; follow [official Job Board API docs](https://developers.greenhouse.io/job-board) |
| Lever Postings API | Automatic | Current jobs for a known site name | Job identity, title, location, team, URL, observed times | Public structured feed, free | Site name must be known; verify current API behavior in the [official postings repository](https://github.com/lever/postings-api) |
| Ashby public job-posting API | Automatic | Current listed jobs for a known board name | Listed job identity, title, location, department, URL, published time | Public structured feed, free | Store only listed postings; use the [official public API](https://developers.ashbyhq.com/docs/public-job-posting-api) |
| DataSF registered businesses | Automatic seed | Discover San Francisco business names/addresses | Source ID, name, address, classification, observed time | Broad, free public seed | No key required; an optional `SOCRATA_APP_TOKEN` can improve rate limits. It is not a startup or hiring source; dedupe and qualify later. See [DataSF](https://data.sfgov.org/Economy-and-Community/Registered-Business-Locations-San-Francisco/g8m3-pdis/about_data) |
| Hacker News “Who is hiring?” | Signal only | Find companies explicitly discussing open roles and Bay Area presence | Company/job clue, comment/item URL, excerpt, timestamp, selected non-LinkedIn external URL | Timely founder/employer signal, free | Uses the [official Hacker News API](https://github.com/HackerNews/API) and latest Ask HN thread; keeps only Bay Area signals and does not harvest emails from comments. It can contribute current counts and prioritization but cannot complete Hiring now until confirmed on the company site, a supported ATS, or an owner-confirmed manual source |
| Brave Search API | Automatic, licensed | Resolve missing official company domains | Query, up to five candidate URLs/snippets/scores, captured time | Fills domain gaps without scraping a search UI | Key required. LinkedIn, YC, paid directories, and ATS hosts are excluded. Candidate domains are review evidence; auto-apply occurs only when the owner opts in and the conservative score/lead thresholds pass. [Current API pricing](https://brave.com/search/api/) is per request and result-storage rights depend on the selected plan |
| Apollo organization search | Automatic, licensed | Bay Area company discovery and size/job filters | Provider ID, company facts, provider evidence | Structured, scalable | Current official metering documents one credit per results page, up to 100 results/page; entitlements and fields remain plan-dependent. Organization search does not prove hiring or fit. See [organization search](https://docs.apollo.io/reference/organization-search) and [API pricing](https://docs.apollo.io/docs/api-pricing) |
| Apollo people search/enrichment | Manual action, licensed | Rank a small candidate set and enrich only the current primary | Name, title, company, public profile URL; work email when returned for the primary | Faster people coverage without paying for every alternate | People Search itself currently uses no credits but requires a master API key and does not return email/phone. RecruitAI retains up to three ranked names/titles, enriches only the first/current primary, explicitly requests no personal email and no phone, and marks any returned work email `unverified`. Enrichment is currently documented as 1–9 credits/person depending on returned data. See [people search](https://docs.apollo.io/reference/people-api-search), [enrichment](https://docs.apollo.io/reference/people-enrichment), and [API pricing](https://docs.apollo.io/docs/api-pricing) |
| Hunter Email Finder | Manual action, licensed | Find an address for one selected person/domain | Address, provider score/status, sources, timestamp | Domain/person-specific, cost controlled | A found address is kept unverified until a fresh dedicated verifier request confirms the exact current address. All-in-one plans currently document one Finder credit when an email is found; Data Platform/API plans can use a different pool. Confirm the purchased product in [official API docs](https://hunter.io/api-documentation) and [credit documentation](https://help.hunter.io/en/articles/1911617-how-do-credits-work-in-hunter) |
| Hunter Email Verifier | Manual action, licensed | Pre-confirm address deliverability category | Status, score, verification timestamp, provider evidence | Clear valid/invalid/accept-all/unknown outcomes | All-in-one plans currently document one-half credit for a completed verification, while API-oriented plans can meter a separate verification pool. Repeated/unknown-request charging also varies by product. `accept_all` and `unknown` remain review-only; reverify before send |
| ZeroBounce | Manual optional action, licensed | Optional second verifier for ambiguous addresses | Only verification result and timestamp | Independent verifier; public bulk pricing | Key required and inactive until selected. Current pay-as-you-go examples publish 10,000 checks at $0.0129 each, a 2,000-credit/$39 minimum, no charge for `unknown`, and non-expiring credits; re-check [current pricing](https://www.zerobounce.net/email-validation-pricing.html) before purchase |
| Y Combinator company/jobs pages | Manual | Research YC affiliation, company page, and jobs | Manually confirmed URL and note | Useful Bay Area startup directory | No automated directory scraping. Open [Bay Area hiring companies](https://www.ycombinator.com/companies/location/san-francisco-bay-area/hiring) or [YC Jobs](https://www.ycombinator.com/jobs) manually and respect [YC terms](https://www.ycombinator.com/legal/) |
| LinkedIn | Manual | Confirm a likely person and current title | Manually confirmed profile URL, note, timestamp | Broad professional identity coverage | No login automation, cookie ingestion, profile scraping, or access-control bypass |
| General manual web research | Manual | Confirm an official domain, careers page, ATS identifier, or public press evidence not resolved automatically | Owner-selected URL, excerpt/note, timestamp | Handles ambiguous edge cases | Search snippets are not final proof; save the selected source and confirm the first-party page. Authenticated or access-controlled scraping is not available |
| CSV | Manual import | Bring owner-licensed seed lists into the queue | Mapped company/contact fields plus import label | Simple interoperability | Owner must have the right to use the data; imports are unreviewed; formula-safe export and dedupe required |
| Crunchbase, PitchBook, other commercial databases | Disabled by default | Funding, size, company discovery | Only fields allowed by a licensed plan | Good company coverage | Use only a contract/API that permits the intended internal use and retention; do not scrape paid interfaces |
| Google Maps/Places | Excluded from persistent enrichment | Possible address/domain lookup | None by default | Broad local coverage | Google Places has storage and attribution restrictions; do not build the durable dataset from cached Places results without a compliant design |

Adding a source requires a policy entry, its official documentation/terms link, a data-retention decision, a rate-limit plan, deterministic test fixtures, and a failure mode that cannot corrupt approved records.

In Settings, **Connected** means a secret is configured, not that a provider guarantees the requested endpoint. **Test connection** performs a live provider-specific check. Apollo’s health check authenticates the key without consuming credits but cannot prove organization/people endpoint entitlements or remaining credits; Hunter and ZeroBounce tests can report account/credit information; Brave’s test performs one billable/search-credit query. A successful test still does not replace checking the plan’s endpoint access, permitted retention, result-storage rights, and current price.

## 5. Qualification and ranking

### Company identity and deduplication

Use the normalized registrable domain as the strongest key. Fall back to normalized legal/company name plus Bay Area address. Retain aliases and source IDs. Never merge solely because names are similar.

The current conflict engine creates explicit records when duplicate company rows share a normalized name but cannot be safely merged, and when evidence submitted under a supported canonical field name disagrees with the current company/contact value. The owner can then keep the current value, use the candidate where supported, or keep researching; every path retains the evidence.

Provider payloads that bundle several facts under one broad evidence field do not yet create separate size/location/employment conflicts automatically. Those differences remain inspectable in the source trail and can be recorded as canonical-field manual evidence. Expanding source adapters to emit field-level contradiction candidates is a target refinement.

### Hiring-intent score

The score is a sorting aid, not a truth label. Show the components:

- up to 40 points: active jobs observed inside the configured hiring window;
- up to 20 points: freshness and repeated observation;
- up to 15 points: Bay Area and 3–1,000 employee fit;
- up to 15 points: likelihood of benefiting from external recruiting;
- up to 10 points: evidence completeness.

Useful high-intent evidence includes multiple active roles, hard-to-fill technical/research roles, recent job publication, rapid job-count growth, and explicit founder/employer hiring statements. Funding alone is weak evidence.

The “external help” component changes only from the owner-reviewed `recruiting_fit` value. Mark it unlikely or excluded when evidence shows many internal recruiters, a large talent-acquisition organization, or a public statement that agencies are not accepted. The system cannot know whether a company has an exclusive agency contract; leave this unknown unless evidence exists.

When **Auto-prioritize companies with current hiring evidence** is enabled, a score recomputation promotes any company with a current open-role count to High. It never silently demotes an owner-set priority.

### Decision-maker ladder

Rank people using company size and public responsibility:

| Company size | Primary order | Alternate order |
|---|---|---|
| 3–20 | CEO/cofounder, then COO | functional leader for the open role |
| 21–75 | Head of People/Talent if present; otherwise CEO/COO | recruiter or functional leader |
| 76–250 | Head/VP People or Talent Acquisition | COO, functional VP, recruiting lead |
| 251–1,000 | VP/Head/Director Talent or relevant functional executive | recruiting leader, people leader, COO |

Titles do not prove buying authority. Confirm current employment and relevance. Store several candidates if useful, but enrich and contact only the current primary. After a documented no-response round, the owner may deliberately advance the next alternate.

## 6. Email and phone policy

### Address acquisition

Use this order:

1. work email published by the company or returned by a licensed enrichment provider;
2. work email found for a confirmed name and company domain;
3. confirmed company generic address when no person-specific route exists;
4. personal/direct email only when no work route is available and a human accepts the reason.

Do not mark pattern-guessed emails as existing. A pattern can create a candidate value only; it must be verified before approval. Do not collect phone numbers automatically. The owner may add a confirmed business or direct number with source evidence.

### Verification states

| State | Meaning | Default action |
|---|---|---|
| `valid` | Verifier reports deliverable | Eligible if inside the configured 1–30 day window (default 30) and identity/employment are confirmed |
| `invalid` | Verifier reports undeliverable | Never send; keep history |
| `accept_all` | Domain accepts recipients without proving mailbox existence | Research/review only; cannot satisfy send readiness |
| `unknown` | Verifier could not decide | Re-research or use another permitted verifier |
| `disposable` | Disposable address detected | Reject |
| `do_not_mail` | Provider or owner suppression | Never send |
| `unverified` | No current check | Ineligible for send |

Verification confirms a delivery category, not that the person still works at the company or reads the mailbox. Employment evidence and address verification are separate review checks.

### Cost-control sequence

Do not enrich three fully verified people at every company. At 10,000 companies, that turns a one-contact workflow into 30,000 paid records.

Instead:

1. qualify the company using free/low-cost hiring sources;
2. identify up to three names and titles;
3. select one primary;
4. enrich the primary;
5. verify the selected email;
6. pay for an alternate only after the first route fails or a later outreach round begins.

## 7. Cost model

Provider prices and included credits change; confirm the checkout page before a run. Taxes, overages, search APIs, proxy services, and developer time are excluded.

Hunter’s [pricing](https://hunter.io/pricing) and [credit rules](https://help.hunter.io/en/articles/1911617-how-do-credits-work-in-hunter) are product-dependent. Its all-in-one plans currently describe Finder as one credit when an email is found and Verifier as one-half credit when verification completes; repeated identical requests in a billing period and `unknown` results may not be charged. The Data Platform/API product can instead use separate Search and Verification pools and documents one verification credit per API verification. Therefore “15,000 credits for 10,000 find-and-verify attempts” is only an all-in-one planning case, not a universal quote. Inspect the actual account before launching the run.

ZeroBounce’s [published pay-as-you-go table](https://www.zerobounce.net/email-validation-pricing.html) currently shows 10,000 checks at about $0.0129 each, or roughly $129; its minimum purchase and subscriptions differ, `unknown` results are not charged, and purchased credits are described as non-expiring. The adapter is optional and it does not replace person-finding costs.

Brave Search currently advertises $5 per 1,000 requests and a $5 monthly credit on its [Search API page](https://brave.com/search/api/). The connection test uses one query. Storing returned result data requires a compatible plan, so the owner must confirm retention rights before a large domain-resolution run.

Apollo’s API access, master-key requirement, returned fields, and credit usage are plan-dependent. Current official documentation describes organization search as one credit/page, people search as no-credit/no-contact-data, and people enrichment as 1–9 credits/person depending on returned data. RecruitAI enriches only the primary and explicitly requests neither personal email nor phone. Obtain a current quote using its [API pricing guide](https://docs.apollo.io/docs/api-pricing) before using it as the 10,000-company backbone.

Illustrative scenarios:

| Scenario | Paid work | Likely direct cost | Trade-off |
|---|---|---:|---|
| Evidence-first pilot | Free public sources; 100–250 primary enrichments/verifications | Free tier to low hundreds | Best way to validate precision and UX |
| Lean 10,000-company qualification | Free public discovery/ATS; pay only for primaries at qualified companies | Hunter/Apollo/Brave account quote based on actual qualified primaries and missing domains | More manual name research, lowest API spend |
| API-heavy | Apollo company and person coverage plus verifier for most records | Quote/credit dependent; likely well above the 1–5¢ total-record target | Faster, less manual review, greater vendor dependence |

The requested 1–5¢ range is realistic for some verification-only operations, not for full company discovery, people enrichment, verification, evidence capture, and human review. Track actual spend per approved primary, not per raw API response.

## 8. Gmail architecture and throughput

### Recommended integration

Use the official Gmail REST API, not browser automation, copied cookies, SMTP password storage, or an unofficial CLI. The relevant references are Google’s [sending guide](https://developers.google.com/workspace/gmail/api/guides/sending), [OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [installed-app OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app), and [quota reference](https://developers.google.com/workspace/gmail/api/reference/quota).

For a local desktop-style application:

1. the owner supplies a Google OAuth desktop-app client ID and client secret;
2. RecruitAI creates a PKCE authorization URL with a loopback redirect on `127.0.0.1`;
3. the system browser performs Google sign-in and consent;
4. the refresh token is stored locally as a secret, never in Git or the main CRM tables;
5. the minimum scope for direct send is `gmail.send`;
6. messages are constructed as RFC 2822/MIME, base64url encoded, and sent with `users.messages.send`;
7. Gmail message/thread IDs and the provider response are written to the audit log.

If the product later creates Gmail drafts, request `gmail.compose` only when that feature is enabled. Reply/bounce synchronization generally needs read access such as `gmail.readonly`, which is a restricted scope and can substantially increase Google verification obligations. For a single local owner, polling is simpler than Gmail push, which requires Google Cloud Pub/Sub; see the [push notification guide](https://developers.google.com/workspace/gmail/api/guides/push). Do not request read scope in the first sending release.

Google’s API quota is not the practical safety limit. The current application enforces:

- maximum 20 sends per rolling hour;
- configurable 1–400 daily cap, default 200;
- owner-defined day-of-week and local-time window, default Monday–Friday, 08:00–20:00 in the machine’s IANA time zone;
- one company/contact at a time;
- one explicit confirmation for every message, with no queue processor;
- disable-on-threshold after owner-recorded bounces when that option is enabled;
- immediate stop on auth, suppression, review, freshness, schedule, or rate errors;
- explicit owner approval before a draft is eligible; and
- a saved sending-enabled toggle that acts as the global pause.

Connection alone is not enough. The owner must save the current sender name, postal address, opt-out text, and compliance confirmation, then send one successful test message to the connected Gmail account. Reconnecting or disconnecting Gmail clears the self-test and disables sending until the current setup is tested again.

At 20 messages/hour, 10,000 messages require 500 sending hours. The default 200/day cap permits at most about 4,200–4,600 messages across 21–23 weekdays in a 30-day month, even though the 08:00–20:00 window is 12 hours. Even running all 30 calendar days at the default daily cap reaches only 6,000. Reaching 10,000 in 30 days would require about 334/day and 16.7 sending hours every calendar day, plus the owner’s separate confirmation for every message. It would still have to remain within Google account/recipient limits, applicable law, and deliverability safeguards. The current UI shows actual usage and configured caps, not a 10,000-message projection; rollout planning must not imply that the entire list can be safely contacted in a month.

The implemented local workbench prepares and approves drafts and can send one specifically confirmed message at a time after the compliance gate, OAuth connection, self-test, rate limiter, suppression checks, and data/readiness checks pass. Requests are serialized. A definitive pre-acceptance failure returns the draft to approved; an ambiguous network result moves it to `send_unknown` and requires checking Gmail rather than blind retry.

The owner can manually mark a sent item `replied`, `bounced`, or `no_response`. `no_response` is unavailable until the configured wait (default seven days); `bounced` invalidates and suppresses the address and can disable sending at the configured seven-day bounce threshold; `replied` blocks additional company outreach. After a bounce or no response, the owner must deliberately make a different decision-maker primary and create/edit/approve a new draft. The app does not promote an alternate automatically.

There is deliberately no unattended queue processor, randomized scheduler, Gmail read scope, reply synchronization, or bounce polling. Those remain target refinements only if the product later takes on the additional operational and OAuth obligations.

## 9. Local architecture

### Process layout

- Bun runs one local Hono API bound to `127.0.0.1`, never all network interfaces by default.
- Vite serves the React UI during development.
- The production Bun executable embeds the built UI, starts the loopback server, and opens the system browser.
- Public-site research currently uses bounded HTTP fetches/parsers only, selects stale/never-researched queued companies, crawls at most three companies concurrently, and ingests detected public Greenhouse/Lever/Ashby boards. A permitted browser fallback is a target refinement for public JavaScript-only pages.
- Source runs execute asynchronously in the local server process and write state/counts to SQLite. They can be inspected and rerun; an interrupted queued/running run is marked failed on the next start rather than checkpoint-resumed.

This architecture is smaller than Electron and easier to ship as a single executable. It is not a native-window application: the UI runs in the owner’s browser. If a native window, OS keychain integration, or automatic updates become mandatory, a thin Tauri shell is the preferred second route; Electron is the compatibility-heavy third route.

### SQLite and file layout

Development data lives under `./data`; packaged builds should use the platform’s per-user application-data directory. The directory is Git-ignored.

```text
data/
  backups/
  recruit-ai.sqlite
  recruit-ai.sqlite-wal
  recruit-ai.sqlite-shm
  snapshots/
```

SQLite uses WAL mode on macOS/Linux and the rollback journal on native Windows, plus foreign keys, a busy timeout, indexes for review/hiring queues, and FTS5 for company search. The Windows choice avoids a Bun runtime WAL-handle issue that otherwise prevents safe in-process backup replacement; the single-owner concurrency model does not need WAL there. One local owner and a bounded number of background workers are the intended concurrency model.

Core tables:

- `companies`: normalized identity, location, size, industries, fit/recruiting qualification, exclusion, status, priority, hiring score/counts and review state;
- `company_aliases`: alternate names and source-specific identities;
- `contacts`: person, title, rank, channel, fallback rationale, phone proof, current-employment observation, verification, review and suppression state;
- `jobs`: source-specific job identity, active/manual-live state, first/last seen, observation and publication time;
- `evidence`: source, field, value, excerpt, confidence, timestamp, snapshot path and provider payload;
- `conflicts`: current/candidate values, supporting evidence and keep/use/research resolution history;
- `source_runs`: parameters, lifecycle, counts and errors;
- `reviews`: immutable company review decisions and notes;
- `outreach_drafts`: subject/body/edit/status, Gmail identifiers and manual outcome note/time;
- `suppression_entries`: address/domain/person suppression reasons;
- `audit_events`: immutable material changes;
- `settings`: non-secret local configuration.

Provider payloads and snapshots are evidence, not the current canonical value. Canonical values remain editable, while history remains append-only.

### Secrets

Environment values override local secrets for development. The current local fallback is a secrets table inside the Git-ignored SQLite database. This is appropriate for a single-owner local prototype but is not OS-keychain encryption. Before distributing signed desktop binaries broadly, migrate OAuth refresh tokens and API keys to macOS Keychain, Windows Credential Manager, or Linux Secret Service. Never put secrets, cookies, raw provider exports, or production data in fixtures.

### Security controls

- bind only to loopback;
- require a custom header on state-changing API calls;
- send `no-store`, framing, referrer, and MIME-sniffing protections;
- validate every request with schemas;
- resolve and reject private/link-local network destinations before crawling to reduce SSRF risk;
- honor `robots.txt`, response size, content-type, page-count, and timeout limits;
- neutralize spreadsheet formulas in CSV exports;
- redact secrets from errors and logs;
- use transactional writes for multi-entity updates; and
- use the built-in full backup flow rather than copying a live WAL database arbitrarily. It checkpoints WAL, packages the SQLite bytes and current snapshots in a versioned JSON artifact, validates SQLite before restore, creates a pre-restore safety backup, and atomically replaces the database plus exact snapshot set with rollback protection. Because SQLite contains local secrets, every full backup also contains provider keys and the Gmail refresh token and must be protected accordingly.

## 10. Data contract and CSV

Every exported contact row should include:

- company ID, name, domain, website, location, size range, industries, stage;
- hiring score, open/fresh role counts, priority, status, review flag;
- company LinkedIn/YC manual URLs, notes, last-researched time;
- contact ID, name, title, role category, rank, status, review flag;
- email, email type, verification status and timestamp;
- phone, phone type, contact LinkedIn manual URL and notes; and
- evidence URLs.

IDs are stable UUIDs. Times are ISO 8601 UTC. Multi-value fields use a documented delimiter in CSV and native arrays in JSON. CSV output quotes all cells, uses CRLF, and prefixes values beginning with `=`, `+`, `-`, or `@` to prevent spreadsheet formula execution.

The current contacts CSV implements that stable flattened set and also includes company description/qualification/exclusions, all five score components, conflict count, boolean company/contact suppression indicators, fallback proof, employment proof, phone provenance, and last-outreach state/time. It is still not a normalized database export: individual job/evidence/conflict/suppression/history rows, settings, provider payloads, and secret material remain in SQLite. Use the versioned full backup for complete recovery. Export does not imply permission to send, and a CSV row cannot bypass readiness.

The exact internal entities, state values, import aliases, and ordered CSV columns are specified in the [data dictionary](DATA_DICTIONARY.md).

## 11. Idempotency, scaling, and reliability

Each source run receives a UUID and normalized parameter hash. A re-run may refresh `last_seen_at` and evidence, but must not duplicate a company, contact, or job. Use provider external IDs when available and domain/name keys otherwise.

The current runner:

- rejects a duplicate queued/running source plus parameter hash;
- the UI starts one discovery job at a time in the local server process; the queued-company website adapter internally crawls at most three companies concurrently;
- most API adapters use the shared HTTP helper, which retries up to three attempts for 429/5xx, honors bounded `Retry-After`, and otherwise applies exponential backoff with jitter; the validated site-crawler redirect path does not currently retry;
- records per-run inserted, updated, and skipped counts plus a failed status/message;
- content-addresses public-page snapshots so identical HTML reuses the same snapshot filename; each later observation can still append a new evidence row;
- uses database transactions for operations that explicitly bundle multi-record writes, including CSV import; and
- marks an interrupted queued/running row failed on restart so the owner can rerun it.

Target refinements before relying on unattended 10,000-record runs are provider-specific token buckets, cursor/page checkpoints, batch-level restart, explicit maximum/dead-letter states, safe cancellation, and a coordinator pause. These controls are not implied by the current source-run history UI.

SQLite is suitable for a single owner and tens of thousands of companies/contacts. The current `bun run benchmark:10k` check passed with 10,000 companies, contacts, and jobs: roughly 10–12 seconds to build the temporary fixture and about 45 ms for the first 100-row queue query on the development machine across recent runs. This is an engineering sanity check, not evidence of real-provider throughput or review usability. Move to a server database only if the product becomes multi-user or concurrent write volume materially exceeds the local model; PostgreSQL is intentionally out of scope.

## 12. Review model

The review unit is a company bundle: company facts, current jobs, decision-makers, selected channel, verification, conflicts, evidence, and draft readiness.

The implementation deliberately separates a reviewed company decision from send readiness.

**Approve company** requires:

- recognized Bay Area location, exact size bounds inside 3–1,000, at least one technology industry, explicit fit confirmation, and `recruiting_fit = likely`;
- at least one active company-site/supported-ATS or owner-confirmed manual job whose latest observation is inside both the configured hiring window and separate refresh target; lead-only Hacker News jobs do not satisfy this gate;
- at least one company evidence item inside the configured evidence-age limit;
- no company exclusion;
- no unresolved conflict;
- no suppression; and
- `reviewed` checked by the owner.

Company approval can therefore be retained while the person or email remains incomplete. **Send readiness** rechecks current hiring and company evidence, then additionally requires one reviewed primary decision-maker, manually confirmed observed title and employment date no more than 180 days old, a selected email, a documented/confirmed fallback for any personal or generic route, a dedicated verifier result of `valid` inside the configured 1–30 day freshness window, an individually edited and approved draft, a successful current Gmail self-test, all Gmail/compliance/rate/window gates, and no unresolved prior company outreach.

`accept_all`, `unknown`, unverified, stale, invalid, disposable, do-not-mail, or evidence-poor routes do not become send-ready. A personal or generic address can qualify only when it separately verifies `valid` and its fallback reason is confirmed. The owner can keep any of these as approved research records while outreach remains blocked.

Review decisions are `approved`, `needs_research`, or `rejected`. Rejection keeps source history. Any material post-approval change to the domain, primary contact, email, company employment, hiring evidence, or verification state reopens the affected checks.

## 13. Implementation phases and acceptance criteria

| Phase | Current state |
|---|---|
| 0. Policy/product contract | Core source registry, data contract, gates, suppressions, and safe-source boundary are implemented; provider spend is exposed only where a test returns credits, while a complete run-cost ledger remains a target refinement |
| 1. Local foundation | Implemented |
| 2. Company discovery | Implemented for DataSF, HN, Brave domain resolution, Apollo organizations, ATS boards, bounded three-company website batches, and mapped CSV |
| 3. Hiring evidence | Implemented, including website-detected ATS ingestion, latest-observation freshness, refresh/evidence-age gates, snapshots, job lifecycle, score breakdown, and explicit conflicts |
| 4. Decision-makers | Implemented, including size-aware order, Apollo people search with primary-only work-email enrichment, manual employment confirmation, primary/alternate history, and manual-only phone proof |
| 5. Email verification | Implemented for Hunter and optional ZeroBounce |
| 6. Queue-first review | Implemented |
| 7. Tailored drafts | Implemented; API supports concise/technical/founder variants, while the current one-click UI uses concise by default |
| 8. Gated Gmail send | Implemented for explicit one-at-a-time sends, self-test, manual outcomes, and safety gates; no unattended queue or inbox sync |
| 9. Packaging | Version synchronization, cross-platform builds, native-runner isolated smoke tests, versioned archives, license/notices, manifests/checksums, platform data paths, and an unsigned draft-release workflow are implemented; signed/notarized artifacts, provenance/attestations, a default-data-path clean-install exercise, and a prior-version upgrade exercise remain |
| 10. Staged scale validation | Synthetic 10,000-company benchmark completed (roughly 10–12 seconds to build the fixture and about 45 ms for the first 100-row queue query on the development machine across recent runs); 100/1,000-company quality/cost/recovery pilots and production validation remain |

The deliver/accept lists below are the phase contract. An implemented phase can still have an unperformed real-provider, clean-machine, or production-outreach acceptance exercise.

### Phase 0 — policy and product contract

Deliver:

- source-policy registry;
- field-level data contract;
- review/send gates;
- suppression semantics;
- provider credit/account details where a live connection test exposes them; a full per-run cost ledger remains a target refinement;
- no LinkedIn cookie or authenticated-scrape capability.

Accept when every source has an owner, mode, official reference, retained fields, freshness rule, and disable path.

### Phase 1 — local foundation

Deliver:

- Bun/Hono/React app;
- SQLite schema, migrations, platform-safe journaling, FTS;
- loopback-only service;
- local data paths, audit events, settings and secret abstraction;
- checkpointed full backup/inspection/restore, compaction, demo cleanup, and recovery-before-delete;
- demo workspace containing only fictional `.example` records.

Accept when a clean install can run `bun run dev`, reload without data loss, and pass schema, API, and CSV tests.

### Phase 2 — company discovery

Deliver:

- DataSF, Hacker News signal, CSV, and Apollo organization adapters;
- domain/name normalization and aliases;
- source-run status, counts, retries, and errors;
- source-policy UI.

Accept when repeated identical runs create no duplicate companies and all imported rows begin unreviewed.

### Phase 3 — hiring evidence

Deliver:

- Greenhouse, Lever, and Ashby adapters;
- bounded three-company-at-a-time site research with snapshots, structured jobs, and detected supported-ATS ingestion;
- active/stale job lifecycle based on latest observation, separate refresh/evidence-age readiness, and hiring-score components;
- explicit conflict records.

Accept when every high-priority company can show the job URL, source, captured time, and freshness state that produced its ranking.

### Phase 4 — decision-makers

Deliver:

- size-aware ranking;
- Apollo people search for ranked names/titles and enrichment only for the current primary, with personal email and phone disabled;
- manual person and manual LinkedIn-confirmation flow;
- primary/alternate/left-company/suppressed states;
- no automatic phone collection.

Accept when the owner can understand and edit why the primary was selected, and alternatives are never contacted in the same round.

### Phase 5 — email verification

Deliver:

- Hunter Finder and Verifier;
- status mapping, evidence, timestamps, and account-credit details where provider connection endpoints expose them; a per-run credit ledger is a target refinement;
- staleness and catch-all rules;
- optional second-verifier interface, disabled by default;
- do-not-mail suppression.

Accept when invalid, disposable, stale, unknown, accept-all, and suppressed addresses cannot become send-ready; only a separately `valid` personal/generic address can use the documented fallback path.

### Phase 6 — queue-first review

Deliver:

- searchable, filterable company queue;
- reusable company workspace;
- evidence/conflict viewer;
- inline editing and manual evidence;
- reviewed checkbox and immutable decision log;
- full CSV export.

Accept when an owner can review a 100-company pilot without opening the database directly and can resume at the next unresolved record.

### Phase 7 — tailored drafts

Deliver:

- deterministic size/sector/job-aware templates;
- concise, technical, and founder tone options;
- editable subject/body;
- one current primary contact per company, with alternates retained;
- approval state and audit.

Accept when no draft is approved without manual editing/review and generated text never fabricates company facts not present in evidence.

### Phase 8 — gated Gmail send

Deliver:

- installed-app OAuth with PKCE and loopback callback;
- `gmail.send` only;
- compliance settings gate;
- successful test-to-self gate, cleared by Gmail reconnect/disconnect;
- rolling hourly/daily limiter and working window;
- final suppression/freshness check;
- global pause;
- Gmail IDs and immutable send result;
- manual replied/bounced/no-response recording;
- retry logic that cannot double-send.

Accept when a dedicated test account can authorize, pass the test-to-self gate, send one approved message, record its Gmail IDs, record each manual outcome, survive a restart, and prove that replaying the same draft cannot send it twice. Do not begin production outreach in this phase’s engineering test.

### Phase 9 — packaging

Deliver:

- current-platform Bun executable;
- native-built and smoke-tested macOS arm64/x64, Windows x64, and glibc Linux x64 artifacts;
- platform app-data paths;
- versioned `.tar.gz`/`.zip` packages containing the executable, license, platform README, and generated third-party notices;
- a release manifest and `SHA256SUMS` covering every archive;
- a tag/version/default-branch gate that creates only an unsigned GitHub draft; and
- signing/notarization plan (**target refinement**).

The automated native smoke copies each executable to a temporary installation directory outside the checkout, strips provider/Gmail credentials from its child environment, binds it to loopback, exercises API security and mutation behavior, loads direct frontend routes, and proves data survives a restart in an isolated override directory.

Accept when each target additionally launches on a separate clean machine, opens the UI in that platform’s system browser, creates data in the documented default per-user application-data directory, and preserves data across an upgrade from the prior public version. Signing, macOS notarization, Windows code signing, and release provenance/attestation remain publication gates rather than completed work.

### Phase 10 — staged scale validation

Run gates:

1. 100-company precision and UX pilot;
2. 1,000-company idempotency, cost, and recovery pilot;
3. synthetic 10,000-company performance test — **completed** on the development machine with a temporary local fixture;
4. qualified production discovery run with spend cap;
5. manual sample audit before any outreach.

Track:

- precision of Bay Area/size/technology qualification;
- percentage with a fresh hiring signal;
- primary-person accuracy;
- work-email find rate;
- valid/accept-all/unknown/invalid rates;
- API cost per approved primary;
- conflicts and manual minutes per approved company;
- duplicate rate;
- bounce, reply, suppression, and complaint rates only after a compliant sending phase.

Do not scale a stage when its acceptance threshold is unknown. Set thresholds after the first 100-company audit using observed data rather than an arbitrary vendor score.

## 14. Test plan

The current deterministic unit/integration suites cover formula-safe CSV and owner-reviewed mapping; normalization/deduplication; settings validation; Gmail self-test, suppression recheck, ambiguous-delivery recovery, and idempotency gates; full backup/inspect/restore/compact, migration rejection, snapshot rewriting, and destructive confirmations; phone provenance; discovery-run idempotency; strong-versus-lead-only hiring readiness; outreach readiness and alternate sequencing; drafting; evidence/conflict resolution; record lifecycle/review reopening; inert snapshot serving; and private/local network target rejection.

Source-adapter fixtures now cover retryable 429/5xx responses, malformed and empty payloads, pagination, DataSF filtering, current Hacker News hiring-thread selection, Apollo organization/people behavior, Brave domain matching, public Greenhouse/Lever/Ashby ingestion, size-aware contact ranking, primary-only enrichment, Hunter and ZeroBounce status mapping, and suppression outcomes. Website tests cover JSON-LD identifiers, complete-versus-partial crawl job reconciliation, provenance mapping, and failed batch reporting.

The isolated Chromium end-to-end suite exercises CSV import totals, browser navigation/history persistence, dialog secret/value clearing, keyboard tab behavior, ambiguous-send resolution, mobile queue return, automated WCAG A/AA scans, and route/viewport overflow checks. The native binary smoke covers the embedded frontend, loopback/API guards, persistence across restart, and execution from outside the source checkout. The separate `benchmark:10k` script verifies the temporary 10,000-row dashboard and first-page queue path.

Remaining release coverage should add:

- Firefox, WebKit/Safari, and installed system-browser parity;
- real redirect chains, robots denial, DNS answer changes, timeouts, non-HTML responses, and oversized public pages in a controlled network fixture;
- dedicated provider sandbox/acceptance runs without retaining live fixture data;
- a clean-machine packaged-default-data-path exercise on every target;
- a prior-public-version database upgrade and rollback exercise; and
- signature, notarization, provenance/attestation, and installer checks once those release systems exist.

Manual release checks should include one company from each ATS, a company with no ATS, a catch-all domain, a renamed company, a person who changed jobs, and a company with conflicting size/location evidence.

## 15. Decisions still needed before production outreach

Engineering can continue without these answers, but sending cannot:

1. What legal sender name, authenticated Gmail address, postal address, and opt-out wording will be used?
2. What daily cap and local sending window should sit below the hard 20/hour ceiling?
3. How many no-response days define one outreach round before an alternate becomes eligible?
4. What objective public-company criteria implement the requested advocacy/social-justice exclusion without inferring personal beliefs?
5. Which Apollo plan/API allowance is actually available, and what is the hard spend cap?
6. Is Hunter the sole production verifier, or has a second verifier’s contract been approved?
7. What precision, manual-review time, and valid-work-email rates from the 100-company pilot are good enough to scale?
8. What backup location and encryption mechanism will protect the local database?
9. Will distributed binaries be unsigned internal artifacts, or should macOS notarization and Windows code signing be funded?

Until those decisions are recorded, the safe deliverable is a local research, review, draft, and export system—not an unattended outreach engine.
