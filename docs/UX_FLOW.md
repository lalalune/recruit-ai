# Queue-first UX specification

Last reviewed: July 28, 2026

RecruitAI is a one-owner research workbench, not a general CRM. Its primary interaction is resolving the next company in a queue with enough evidence to make one defensible decision.

This specification now describes the implemented interface. Items explicitly labeled **target refinement** are not present in the current release. The current four-page workbench, mapped CSV flow, evidence/conflict tab, provider and Gmail setup, manual outcome controls, and local data maintenance are implemented.

## 1. Three interface routes

### Route A — spreadsheet first

One large grid exposes companies, people, email, verification, jobs, notes, and statuses. Side panels edit a row.

Benefits:

- familiar bulk scanning;
- fast copy/paste;
- simple import/export mental model.

Problems:

- dozens of columns hide evidence and conflicts;
- a company with several people/jobs becomes awkward;
- users confuse “field is populated” with “fact is confirmed”;
- easy to contact multiple people at one company accidentally; and
- poor at showing history, source freshness, or review gates.

Use a table only for compact scanning and export preview, not as the product’s main surface.

### Route B — workflow wizard

A multi-step sequence asks for company, hiring evidence, person, email, verification, review, and draft.

Benefits:

- clear for a first record;
- can enforce completion order; and
- approachable for occasional users.

Problems:

- repetitive across thousands of companies;
- hard to jump to a conflict or missing field;
- hides the relationship between several evidence sources;
- back/forward navigation becomes tedious; and
- encourages “complete the wizard” rather than make a correct decision.

Use small guided dialogs for rare setup tasks only.

### Route C — queue-first workbench

A compact company queue remains visible while one reusable workspace shows company facts, hiring, people, evidence, and review controls. Automation proposes the next action; the owner edits and decides.

Benefits:

- fastest repeated review;
- evidence and conflicts stay adjacent to decisions;
- supports partial records and non-linear research;
- preserves company/contact hierarchy; and
- naturally enforces one primary person per company.

Cost:

- slightly denser initial screen;
- requires careful component reuse and keyboard behavior.

Decision: Route C. Keep only four primary destinations—Discover, Review, Outreach, and Settings. Do not add a separate dashboard, contacts page, evidence page, or activity page; surface those concepts where the owner acts on them.

## 2. Product-wide structure

### App shell

Desktop layout:

- left navigation rail, fixed and narrow;
- page title, description, optional compact status, and scoped page actions;
- content region;
- `Local SQLite` footer label in the rail.

Navigation items:

1. **Discover** — add and refresh companies;
2. **Review** — qualify companies and contacts;
3. **Outreach** — edit and approve one-to-one drafts;
4. **Settings** — connections, rules, compliance, data.

Navigation does not currently show counts or connection dots. At widths below 980 px the rail collapses to icons; below 760 px it becomes a fixed four-item bottom navigation. Review and Outreach retain bounded queue/workspace layouts and switch between list and selected-record surfaces at narrow widths.

### Shared page header

Every page uses:

- short page title;
- one-sentence description;
- optional compact status/meta beside the title;
- at most one dominant page-level action;
- only the secondary actions needed at that scope.

Do not place a row of metric cards beneath every title.

### Shared save model

Editors and credential dialogs use explicit, scoped **Save** and **Cancel** actions; Settings sections use explicit section-level saves. Destructive and delivery actions use confirmation dialogs. The app does not silently autosave a material fact, provider key, review decision, or draft.

Save controls show adjacent progress, success, or error feedback:

- `Saving…`
- `Saved`
- a scoped error notice; retry uses the same save action.

Optimistic updates are allowed only when the original value can be restored after an error. Never optimistically mark a source run complete, an email valid, a review approved, or a message sent.

### Status vocabulary

Company:

- `New`
- `Needs research`
- `Ready for review`
- `Approved`
- `Rejected`
- `Archived`

Person:

- `Candidate`
- `Primary`
- `Alternate`
- `Invalid`
- `Left company`
- `Suppressed`

Email:

- `Unverified`
- `Valid`
- `Accept-all`
- `Unknown`
- `Invalid`
- `Disposable`
- `Do not mail`
- staleness is derived by readiness from the verification timestamp; the stored `Valid` status is not rewritten and the current contact card does not show a separate `Stale` badge

Source run:

- `Queued`
- `Running`
- `Completed`
- `Failed`

Use a text label, with an icon where the component has one, rather than color alone. Reserve red for invalid, failed, destructive, or blocked states. Evidence confidence is shown as a numeric adapter estimate beside the source and captured time; it is not a substitute for review.

## 3. Discover

### Purpose

Start a bounded source run, import a licensed CSV, see what changed, and understand which shipped sources are automatic, signal-only, or manual. Disabled source categories remain documented in the research plan rather than shown as runnable UI rows.

### Header

- Title: **Discover**
- Description: “Build the company universe from permitted public sources and licensed providers.”
- Header action: **Export CSV**.
- The compact research composer is always visible. A **Load fictional demo records** action appears only in the empty recent-activity state.

### Summary strip

One compact line:

`[companies] Companies · [open roles] Open roles · [needs review] Needs review · [valid emails] Valid emails`

These are read-only workspace totals in one strip, not dashboard cards.

### Run composer

Use three route tabs:

1. **Source**
2. **Job board**
3. **Import CSV**

Only the selected route’s fields render.

#### Public sources

Field: **Source**, single-choice radio list:

- DataSF
- Hacker News
- Apollo
- Resolve missing company domains
- Research queued company websites

Selecting a source reveals only its relevant controls.

DataSF controls:

- **Maximum companies**, integer input, default `500`, min `1`, max `10,000`.
- **Restrict to technology-related NAICS codes**, checked by default.

Hacker News controls:

- **Maximum companies**, integer input, min `1`, max `500`.
- Read-only helper: “Uses the latest Ask HN ‘Who is hiring?’ thread; contact information in comments is not collected.”

Apollo controls:

- **Maximum organizations**, integer input, default `500`, min `1`, max `10,000`.
- Helper states that a configured master API key is required; missing/invalid credentials surface as a run error and are configured in Settings.

Brave domain-resolution controls:

- **Maximum companies**, min `1`, max `10,000`;
- checkbox **Apply only high-confidence exact-name domains automatically**, unchecked by default;
- without that checkbox, up to five scored candidates stay as evidence for review;
- the automatic threshold remains conservative and excluded hosts such as LinkedIn/YC/ATS directories cannot be applied.

Queued-company website research controls:

- **Maximum companies**, min `1`, max `10,000`;
- no free-form URL input: the run selects non-rejected/non-archived companies with a website/domain whose `last_researched_at` is missing or older than **Refresh hiring after**;
- up to three companies are crawled concurrently;
- page, content-size, same-origin, redirect/DNS, and `robots.txt` limits come from saved safe defaults;
- supported Greenhouse/Lever/Ashby links discovered on a company page are ingested immediately through their public APIs.

Footer actions:

- Primary: **Start research**; for CSV, label **Import [row count] records**.
- Quiet helper: “No outreach is sent by research runs.”

Starting keeps the composer visible, adds a queued/running row to Recent activity, and disables a second start while research is running. A normalized parameter hash reuses an identical active run.

#### Job board

Field: **Provider**, select:

- Greenhouse
- Lever
- Ashby

Field: **Board name or public job-board URL**, required text:

- Greenhouse helper/example: the board token from `boards.greenhouse.io/{token}`;
- Lever helper/example: the site name from `jobs.lever.co/{site}`;
- Ashby helper/example: the board name from `jobs.ashbyhq.com/{name}`.

Optional field: **Attach to existing company**, select populated with up to 200 existing companies sorted by name.

- When selected, jobs attach to that record.
- When blank, the adapter creates or reuses a company from the board-provided name or normalized board identifier; selecting a company explicitly is the way to avoid a slug/name mismatch.

Footer:

- Primary: **Start research**.

The app accepts a provider board name or supported public board URL, parses it, and shows the normalized identifier before submission.

#### CSV import

Controls:

- **Choose CSV**, file picker/drop zone; accept `.csv`, maximum 20 MB;
- selected filename, byte size, row count, and **Remove selected file** button;
- **Source label**, text, default filename without extension;
- first row is always treated as headers in the current flow;
- an automatic compact preview of the first five rows after parsing.

Mapping:

- automatically map known names such as company, domain, website, location, employee count, industry, contact name, title, email, phone, and profile URL;
- show every source column with a select: `Ignore`, or one canonical field;
- one canonical field cannot be mapped twice.

Footer:

- Primary: **Import [row count] records**.
- Quiet helper: “No outreach is sent by research runs.”

After import, show inserted, updated, contact, and skipped counts. Imported records begin unreviewed; imported email verification labels are ignored. A phone is retained only when mapped confirmation and source fields prove it. Client parse errors and server validation errors are shown inline; the current result summary does not expose a separate conflicted count.

### Activity

Newest runs appear in a dense five-column list, not cards.

Columns/content:

- source icon and label;
- state badge;
- added count;
- updated count;
- finish/creation time;
- inline failure excerpt when present.

**Open review queue** is the only activity-level action. Progress drawer, run-parameter display, retry shortcut, copied run ID, pause, cancel, and run-specific Review filter are **target refinements**. Current interrupted runs become failed on restart and must be started again from the composer.

### Source policy

The always-visible **Source policy** panel sits beside the composer on wide screens and stacks beneath it on narrow screens.

Each row shows:

- source;
- mode badge: `Automatic`, `Signal only`, or `Manual`;
- concise rule text.

LinkedIn row:

- `Manual`
- text: “Open a search and paste a manually confirmed profile URL. No cookies or profile scraping.”
- external link: **Open LinkedIn manually**, which opens a public search in a browser tab and never asks for credentials.

Y Combinator row:

- `Manual`
- external link: **Open YC hiring directory**.

## 4. Review

### Purpose

Resolve one company bundle at a time. Review owns qualification, company research, jobs, people, contact verification, evidence conflicts, and the final decision.

### Layout

At desktop width:

- compact queue column;
- company workspace, flexible;
- workspace tabs: **Company**, **People**, **Evidence**, and **History**.

The selected company ID and queue filters/sort/page are in the URL so refresh/back/forward work. The current release does not separately persist exact scroll position.

### Queue toolbar

Controls in order:

- **Search companies**, text input; searches name, domain, description, and industry;
- **Review view**, single-select: Unreviewed (default), Needs research, Approved, All companies;
- **Hiring only**, checked by default;
- **Needs**, single-select:
  - Any
  - Has fresh jobs
  - Missing decision-maker
  - Missing email
  - Email needs verification
  - Has conflicts
  - Ready for final review
- **Priority**, single-select: Any, High, Medium, Low;
- **Sort**, select:
  - Best hiring signal (default)
  - Most recent evidence
  - Most open roles
  - Company name
  - Oldest unreviewed
- **Clear filters**, text button shown only when non-default filters are active.

Under the toolbar:

- `Showing [n] of [total]`;
- previous **K** and next **J** record controls;
- Previous/Next page controls when the view exceeds 100 companies.

### Queue row

Each row contains:

- company name;
- location or `Location unknown`;
- open-role count;
- numeric hiring-signal bar/score;
- primary person or `Decision-maker needed`;
- verified-email check when that primary has a `valid` address;
- conflict count when nonzero;

The selected row uses a border/background state, not a large colored block. Right-click behavior is not required.

Empty states:

- title **Queue is clear**;
- helper to adjust filters or collect a new source;
- **Discover companies** link.

### Company workspace header

Content:

- status badge and High-priority badge when applicable;
- company name, location, employee range, and stage;
- stored external links for website, LinkedIn company URL, and YC profile; LinkedIn URLs returned by Apollo remain provider evidence until the owner confirms them.

Buttons:

- **Edit**
- **Exclude**
- **Research website**
- **Find domain**, only when missing;
- **Enrich people**

These are explicit scoped actions; there is no hidden overflow menu or derived single contextual button.

### Readiness checklist

One concise horizontal/stacked checklist:

1. Company fit
2. Hiring now
3. Decision-maker
4. Contact route
5. Email current
6. Company evidence
7. Conflicts resolved
8. Suppression

Each item is `Complete`, `Needs attention`, or `Blocked`. Hiring requires a company-site, supported-ATS, or owner-confirmed manual job observation inside both **Hiring signal window** and **Refresh hiring after**; the smaller window wins. A current Hacker News item can prioritize the record but leaves Hiring now incomplete until confirmed. Company evidence requires a company evidence item inside **Maximum evidence age**. Selecting a person/email item opens **People**; conflicts opens **Evidence**; company/hiring/evidence/suppression remain on **Company**. The checklist is explanatory; it does not replace fields.

### Company section

The header and **Company brief** together display the company name, Bay Area location, employee range, description, industries, stage, normalized domain, source labels, stored company links, internal notes, score breakdown, and research/evidence/conflict summary. Outside-recruiting fit, its rationale, URL fields, company-fit confirmation, priority, and normalized facts remain available in **Edit company**.

Source facts, snapshots, and any disagreements are shown in the shared **Evidence** tab rather than a separate drawer on every field.

**Edit company** dialog fields:

- **Company name**, required text;
- **Domain**, normalized text;
- **Website**, URL;
- **Location**, text;
- **Minimum employees** and **Maximum employees**, non-negative integers;
- **Industries**, comma-separated text;
- **Stage**, optional text;
- **Description**, textarea;
- **LinkedIn company URL**, optional manual URL;
- **YC URL**, optional manual URL;
- **Priority**, High/Medium/Low;
- **Outside recruiting fit**, Needs research/Likely/Unlikely/Excluded;
- **Recruiting-fit note**;
- checkbox **I confirmed Bay Area, technology, 3–1,000 employees, and company-level fit**;
- **Notes**, textarea.
- checkbox **I reviewed the normalized company facts**.

Dialog actions:

- **Save company**
- **Cancel**

Material edits reopen the affected review on the server and retain old evidence.

Company fit controls:

- fit confirmation remains a separate owner checkbox; approval still validates the actual Bay Area text, exact size bounds, industries, and `Likely` outside-recruiting assessment;
- **Exclude company** opens a reason dialog:
  - Outside Bay Area
  - Outside size range
  - Not a technology startup
  - No current hiring
  - Large internal recruiting function
  - Agencies not accepted
  - Public mission/category outside scope
  - Duplicate
  - Other
- **Other** requires a note.

The mission/category exclusion is company-level and manually chosen; the product does not classify individuals’ beliefs.

### Hiring section

Header:

- title **Hiring now**;
- helper “Published roles are the strongest immediate-need signal”;
- **Add live job**.

The Company tab’s signal summary shows `recently seen` and `open` counts. Refreshing an ATS board happens from Discover; **Research website** is in the record header.

Role row:

- title;
- department;
- location;
- published date or first captured date for display; freshness uses the latest source observation;
- state `Open` or `Inactive`;
- external **Open role** link.

**Add job manually** dialog:

- **Title**, required;
- **Location**;
- **Department**;
- **Job URL**, required unless the owner confirms `No public URL`;
- **Posted date**, optional;
- **Observed date**, defaults today;
- **Evidence excerpt**;
- **Confirmed live**, checkbox.

Actions:

- **Save live job**
- **Cancel**

If zero roles exist, show:

- guidance to research the website or add a public job board from Discover;
- the same **Add live job** action.

Funding or growth news can be retained as context but cannot alone satisfy “Hiring now.”

### Decision-makers section

Header:

- title **Decision-makers** and the People-tab count;
- **Add person**.

Company-wide **Enrich people** is in the record header. It uses Apollo search to retain up to three ranked names/titles, makes/enriches only the first primary, requests work email only, and explicitly disables personal email and phone. Any returned email remains Unverified until Hunter/ZeroBounce reports `valid`.

Person row:

- full name;
- title;
- Primary badge when applicable;
- selected-channel summary;
- current-employment confirmation/freshness;
- profile external link when manually stored or returned by Apollo, labeled as requiring manual confirmation;
- manually confirmed phone when present;
- inline actions.

Only one person can be `Primary`. Setting a new primary automatically moves the previous primary to `Alternate` after confirmation. It never deletes that person or changes outreach history.

Row actions:

- **Make primary**
- **Move up**
- pencil **Edit**
- **Mark alternate**
- **Left company**
- **Find work email** when missing;
- **Verify email**, optional **Second check**, and **Draft outreach**.

**Add/Edit person** fields:

- **Full name**, required;
- **Title**;
- **Role category**:
  - Founder/CEO
  - Operations
  - People
  - Talent/recruiting
  - Functional leader
  - Other
- **Work email** and **Email type**;
- for Personal/Generic: **Fallback reason** and **Use only because no preferred work route is available**;
- **Phone**, **Phone type**, plus required proof controls when populated;
- **LinkedIn profile (manual)** with an external **Open a manual LinkedIn search** link;
- **Observed current title**, **Employment observed on**, and the current-employment confirmation checkbox;
- **Contact order**, integer;
- **Status**, candidate/primary/alternate/left company/suppressed;
- **Notes**;
- checkbox **I reviewed this person and their current role**.

There is no login, cookie, password, browser-profile, or “scrape LinkedIn” control.

### Contact route within each person

Email fields:

- **Email address**;
- **Type**, Work/Personal/Generic/Unknown;
- **Verification**, read-only status;
- **Verified at**, read-only time;
- **Find work email**, available when no email is stored;
- **Verify email**, using Hunter;
- **Second check**, shown only when ZeroBounce is configured;
- edit/replace and suppression/status changes through **Edit person**.

Verification result behavior:

- `Valid`: show verification date; readiness derives staleness using the configured 1–30 day window;
- `Accept-all` or `Unknown`: remain non-send-ready; optionally use the configured second verifier;
- `Invalid`/`Disposable`/`Do not mail`: route is blocked;
- changing the address resets verification on the server.

Personal email behavior:

- selecting Personal or Generic reveals reason select:
  - No work email found
  - Founder uses this domain for business
  - Published as business contact
  - Confirmed generic fallback
  - Other documented business reason
- send readiness requires the owner’s checkbox `Use only because no preferred work route is available`.

Phone fields:

- **Phone**, manual text;
- **Type**, Business/Direct/Mobile/Switchboard/Unknown;
- **Source URL or note**, required when a number is added;
- checkbox `I confirmed this number exists`.

There is no phone finder. CSV import retains a phone only when the mapped row also contains explicit confirmation and a source.

### Evidence and conflicts

The **Evidence** workspace tab contains unresolved conflict cards followed by the complete newest-first source trail. Header action: **Add evidence**.

Evidence item:

- fact/field;
- source label;
- captured date/time;
- value;
- excerpt/note;
- numeric adapter-confidence badge;
- **Open source**;
- **View saved snapshot** when available.

When values conflict, show a comparison:

- each candidate value;
- the supporting source and capture time remain visible in the adjacent source trail rather than repeated in the conflict card;
- radio **Current** / keep current;
- radio **Candidate evidence** / use candidate, disabled for potential-duplicate identity conflicts;
- radio **Research further**;
- required **Resolution note**;
- **Resolve conflict**, or **Keep open** for research further.

Resolution writes an audit event and retains all evidence. “Research further” leaves the conflict open and sets company status to Needs research.

**Add manual evidence** fields:

- **Record**, company or one of its contacts;
- **Fact**, General/Current role/Email/Phone/Employee count/Hiring need/Location;
- **Observed value**;
- source URL;
- **Short excerpt or note**;
- checkbox **I checked this source and confirmed the fact**;
- **Add evidence** / **Cancel**.

### Final review

The compact review-decision bar stays anchored beneath the selected workspace. The eight-item readiness strip above it supplies the explanatory summary.

Controls:

- **Reviewed**, required checkbox;
- ellipsis button to show/hide **Review notes**; notes optional for approval and required for Needs research or Reject;
- decision buttons:
  - **Approve**
  - **Needs research**
  - **Reject**

Approve behavior:

- requires Company fit, Hiring now, Company evidence, Conflicts resolved, and Suppression to be complete;
- saves the company as Approved even if decision-maker/email readiness is incomplete;
- moves to the next company in the current queue.

The stronger person, current-employment, fallback, email, draft, Gmail, and rate gates are rechecked only before an actual send.

Needs research:

- requires a note;
- preserves records and moves next.

Reject:

- requires a reason;
- keeps history and suppressions;
- does not delete contacts/jobs/evidence;
- moves next.

The reviewed checkbox is recorded with every decision; it is not a bulk-select checkbox.

## 5. Outreach

### Purpose

Prepare one tailored message to the selected primary person, require a manual edit, approve it, and optionally send that single message after every compliance and data-quality gate passes.

### Header

- Title: **Outreach**
- Description: “Edit and approve deliberate one-to-one messages. Nothing is sent automatically.”
- Status badge: **Manual send only**
- Draft creation remains in the Review workspace beside the approved company and person, so Outreach does not need another creation button.

The selected draft’s readiness panel shows six high-level checks and links to **Review sending settings**. Gmail-specific missing requirements appear below the panel; the server can still return a more specific company/contact/freshness/suppression error after its authoritative send-time recheck.

### Draft queue

One compact selector has exactly three views:

- **Active** — draft, approved, sending, and send-unknown records;
- **Approved** — only approved records;
- **All history** — including sent/history states.

Draft row:

- company and person;
- subject;
- draft status;
- last-edited time.

Only one editable draft (`draft` or `approved`) exists per company/contact pair. Creating again regenerates that existing draft and opens it; unresolved `sending`/`send_unknown` delivery blocks another draft for the same contact.

### Draft editor

Context bar:

- company;
- primary person and selected email;
- draft status;
- **Open record**.

Controls:

- **Subject**, single-line text;
- **Body**, plain-text textarea;
- word count;
- **Copy**;
- **Save changes**;
- **Approve draft** / **Return to draft**.

The current **Draft outreach** button uses the concise variant. The server also supports technical and founder variants, but exposing that selector in Review is a **target refinement**. Regenerating through the API reuses the one active company/contact draft, returns it to `draft`, and clears the recorded manual-edit proof.

Generation rules:

- use only company/contact/job facts present in the record;
- use a bounded context: up to two sector labels, up to two open-role titles in the hiring phrase, and the selected person’s stored role/category;
- explain the contingency 30% first-year-salary arrangement accurately;
- no fabricated familiarity, false urgency, or fake referral;
- preserve `[Your name]` warning until sender identity is configured.

The visible send-readiness list has:

- **Verified recipient**
- **Decision-maker reviewed**
- **Company approved**
- **Message edited and approved**
- **Sender identity**
- **Gmail connected**

Controls:

- **Approve draft**, enabled only after the generated subject or body has actually changed and the content is nonempty with no `[Your name]` placeholder;
- **Open record** to return to company research.

Draft approval does not by itself assert all record/compliance gates. The server stores the manual-edit timestamp. Regeneration clears it; later subject/body changes return the message to draft. Changes to the company or contact reopen their review, and primary/employment/fallback/hiring/evidence/conflict/suppression/fresh-verification/Gmail/rate checks are enforced authoritatively at send even if the draft remains approved.

### Explicit sending controls

When fully configured:

- **Send now with Gmail**, one explicit message;
- a Settings link and the exact list of unmet gates.

Final send confirmation:

- **From**
- **To**
- **Subject**
- current `sent/hourly cap` **Usage**
- **Verified** timestamp and configured validity window
- exact plain-text body and appended footer
- **Send one email**
- **Cancel**

There is no queue processor, scheduler, or bulk “send all.” The server serializes requests, atomically claims only an approved draft, rechecks company/person/employment/fallback/review/manual-edit/verification/suppression/Gmail/window/rate gates, and records the Gmail message/thread IDs. A definitive pre-acceptance failure releases the claim. An ambiguous network result becomes `Send unknown`, tells the owner to inspect Gmail Sent mail, and locks blind retry.

### Reply, bounce, and alternate progression

The current release does not request Gmail read scope. After a sent message, it exposes manual:

- **Mark replied**
- **Bounced**
- **No response**

Mark bounced:

- records date and optional outcome note;
- invalidates the email;
- suppresses the address;
- can turn off Gmail sending after the configured number of owner-recorded bounces in seven days.

Mark no response:

- requires that the configured wait period has elapsed; there is no override;
- keeps the original contact history;
- unlocks deliberate progression to a different primary;
- does not select an alternate, generate a draft, or approve anything automatically.

Mark replied:

- stops company outreach;
- keeps thread/message IDs if available;
- records optional result note.

Each outcome opens a confirmation dialog with an optional note. After bounce or no response, the owner returns to Review, makes a different person primary, and creates a new individually edited draft. Automated inbox sync, bounce detection, and alternate promotion remain **target refinements**.

## 6. Settings

Settings use one scrolling page with these sections:

1. Research scope
2. Research connections
3. Gmail and rate limits
4. Sender identity
5. Local data

### Research scope

Controls:

- **Market**, default `San Francisco Bay Area`;
- **Minimum employees**, `3`;
- **Maximum employees**, `1000`;
- **Technology industries**, comma-separated, default AI/ML/data/robotics/hardware/manufacturing/research;
- **Hiring signal window**, integer 30–180 days, default `180`;
- **Refresh hiring after**, integer days, default `90`;
- **Maximum evidence age**, integer days, default `180`;
- **Company-site page limit**, integer 1–20, default `12`;
- **Email verification window**, integer 1–30, default `30`;
- **Second verifier**, None or ZeroBounce, with ZeroBounce disabled until configured;
- checkbox **Use technology-only classifications for DataSF by default**;
- checkbox **Auto-prioritize companies with current hiring evidence**;
- **Catch-all emails**, Hold for manual review / Exclude from outreach / Keep as reviewed fallback lead; every option remains non-send-ready;
- checkbox **Flag publicly advocacy-oriented company missions for manual fit review**.

Buttons:

- **Save scope**
- **Restore safe defaults**

Restoring asks for confirmation, saves the defaults, and recomputes current company statistics. It does not rewrite historical jobs or evidence.

The hiring-signal window controls open-role counts and scoring. **Refresh hiring after** directly gates Hiring now and selects stale companies for the next website batch. **Maximum evidence age** gates Company evidence. Saving scope recomputes company statistics; enabling auto-prioritize promotes companies with a current role to High. The fixed six-month employment window and configurable email-verification window are also enforced. No setting can make catch-all, unknown, invalid, disposable, do-not-mail, unverified, or stale addresses send-ready.

### Research connections

Each research provider uses the same compact connection row:

- provider name and purpose;
- state `Not configured` or `Connected`, where Connected means a secret is saved;
- masked add/update credential dialog;
- **Test connection**
- **Remove**
- official documentation link.

Providers:

- Apollo API key;
- Hunter API key;
- optional ZeroBounce API key;
- Socrata app token;
- Brave Search API key.

Secret inputs:

- never reveal an existing value;
- placeholder `Saved locally`;
- a blank save does not erase;
- **Remove** requires confirmation;
- error messages never echo secrets.

A provider test is separate from saving the key. It validates a live account/auth endpoint; Apollo’s no-credit health test cannot prove every endpoint entitlement or remaining credits, while Brave’s test performs one query. Error copy directs plan/scope failures back to provider documentation. DataSF, Hacker News, supported public ATS boards, and public company-site research remain available without paid credentials.

### Gmail and rate limits

Gmail connection controls:

- masked **OAuth client ID** and **OAuth client secret** dialog;
- **Save credentials**
- **Connect Gmail**, which opens system-browser OAuth;
- connected Gmail address;
- **Reconnect**
- **Disconnect**, whose confirmation explains that drafts and history remain.

There is no Gmail password, app password, cookie, browser-session field, or inbox-read permission.

Fields:

- **Hourly ceiling**, integer 1–20, default `20`;
- **Daily ceiling**, integer 1–400, default `200`;
- **Sending days**, weekday checkboxes;
- **Start sending after** and **Stop sending at**, local time;
- **Time zone**, defaults system zone and shown explicitly;
- **No-response wait**, integer 1–90 days, default `7`;
- checkbox **Pause sending after repeated manual bounce outcomes**, checked;
- **Bounce threshold**, integer 1–20, default `3` recorded bounces within seven days;
- checkbox **Enable explicit Gmail sends after all readiness checks pass**, disabled until Gmail is connected, identity is complete, and the test passed.

Button states:

- **Save limits**
- **Send test to myself**, enabled only when identity/footer/Gmail are complete; becomes **Send test again** after success.

Enabling requires a confirmation that summarizes exactly what becomes possible. It does not schedule existing drafts.

Connecting, reconnecting, or disconnecting Gmail clears the prior self-test. The API requests `openid`, `email`, and `gmail.send` only; manual reply/bounce/no-response controls do not require inbox-read permission.

### Sender identity

Fields:

- **Sender name**, required;
- **Organization / trading name**, optional;
- **Valid postal address**, required multiline;
- **Opt-out line**, required, editable plain text;
- **Reply handling note (internal)**, optional;
- checkbox confirming truthful sender details and opt-out handling.

The section shows **Sender identity complete** only when the required fields and confirmation are saved. **Save identity** is its only action. Gmail connection, current sender identity, limits, and a successful self-test are all independent gates; none schedules existing drafts.

### Local data

Display:

- resolved **Data folder** and **SQLite database** paths;
- Companies, Contacts, Jobs, and Evidence counts;
- database size;
- snapshot size;
- total backup size and saved-backup count;
- RecruitAI app version and Bun runtime;
- **Last full backup**, date/size/snapshot count, with **Download**.

Actions:

- **Open data folder**
- **Export contacts CSV**
- **Create backup**
- **Restore backup**
- **Compact database**
- **Clear demo data**
- **Delete all data**, destructive zone.

Restore:

- choose backup;
- reject files over 500 MB and validate format/version, safe snapshot names, required tables, and SQLite integrity;
- preview file, Created, Source app, Format, Database size, and Snapshots count;
- require exact `RESTORE LOCAL DATA`;
- create a pre-restore backup;
- replace/reopen the database in process and refresh affected UI queries.

**Create backup** checkpoints WAL and writes a versioned JSON artifact containing the SQLite bytes and exact current top-level snapshot set. Because provider keys and the Gmail refresh token are stored in SQLite, the UI warns that the backup also contains credentials. It remains in `data/backups/` until removed outside the app. Restore atomically replaces the whole snapshot directory, so files absent from the chosen backup are removed; a rollback snapshot/database pair and pre-restore full backup protect failure recovery.

Clear demo:

- requires exact `CLEAR DEMO DATA`;
- removes fictional `.example` companies and dependent records only.

Delete all:

- requires typing `DELETE LOCAL DATA`;
- explains that records, settings, provider secrets, and snapshots will be deleted;
- creates and retains a recovery backup first;
- keeps existing backup files and does not remove the application itself.

## 7. Minimal component system

Use Radix only for behavior-heavy Dialog, Checkbox, and Tooltip primitives; use native selects/buttons plus plain React/CSS for segmented controls and workspace tabs. Lucide supplies consistent line icons. No large component framework is needed.

Reusable components:

- `AppShell`
- `PageHeader`
- `Button` with primary/secondary/ghost/danger variants
- `IconButton`
- `Input`, `Textarea`; native `select` with shared CSS
- `Checkbox`
- `Badge`
- `InlineNotice`
- `Tooltip`
- `Dialog`
- `EmptyState`
- `Spinner`

Queue rows, workspace sections/tabs, readiness items, evidence rows, provider dialogs, typed confirmations, and Settings sections are small page-scoped compositions built from those primitives. There is no generic Drawer, Toast, or form framework in the current component layer.

Do not create a bespoke card for every section. Sections are separated by headings, rules, and spacing. Use one form-control height, one focus-ring treatment, one menu pattern, and one save/error pattern across the app.

### Visual language

- light, calm research-desk surface;
- neutral canvas, white working surface, dark legible text;
- one restrained violet accent;
- semantic colors only for status;
- compact 8 px spacing rhythm;
- readable body text at 14–16 px;
- tabular numerals for counts/times;
- no gradients, glass effects, neon, activity gamification, or decorative dashboards;
- no animation beyond short state transitions; honor reduced motion.

## 8. Interaction and accessibility contract

Keyboard:

- all actions reachable in logical DOM order;
- visible focus ring;
- `J`/`K` moves through queue when focus is not in a field;
- queue rows are links and open with normal link keyboard behavior;
- `Esc` closes the top Radix dialog and restores focus;
- destructive or send actions never have a single-key shortcut.

`Cmd/Ctrl+Enter` save shortcuts are a **target refinement**; current editors use explicit Save buttons.

Accessibility:

- WCAG 2.2 AA contrast;
- every input has a persistent label;
- icon buttons have accessible names and tooltips;
- status never relies on color alone;
- errors attach to fields and are summarized at the top of long dialogs;
- source-run and save results remain visibly adjacent to the action;
- dialogs trap focus and return it to their trigger;
- minimum comfortable target size, including dense rows;
- works at 200% zoom without losing actions;
- tables use real headers when table semantics are present.

External links:

- external-link icon and accessible cue;
- open in a new browser tab;
- never transmit secrets in query strings;
- local snapshot links clearly say **View saved snapshot**.

Loading:

- retain existing data while refreshing;
- use scoped spinners/notices rather than a blocking whole-app loader;
- disable only the action currently in flight;
- long source runs are background activity, not blocking dialogs.

Errors:

- explain what failed and whether data was saved;
- give one concrete next action;
- preserve form input;
- provider errors name the provider but redact keys/payload secrets;
- loss of a provider/network connection fails that scoped request without corrupting saved local data; loss of the local API makes the UI unavailable rather than providing a separate offline-editing cache.

Confirmation:

- required for send, changing primary when another primary exists, Gmail/provider credential removal, sending enablement, restore, demo cleanup, and deletion;
- not required for ordinary edits, filters, or navigation;
- Needs research and Reject require a note rather than a second confirmation.

## 9. End-to-end owner flows

### Flow A — free/public discovery to approved company

1. Discover → Source → Hacker News → Start research.
2. Recent activity shows a completed run; select Open review queue.
3. Review opens the first company in the hiring-signal-sorted queue.
4. Confirm domain/location/size; run Research website.
5. Inspect first-party jobs and resolve any domain conflict.
6. Add or find decision-makers; manually confirm current employment.
7. Make one person Primary.
8. Find and verify a work email.
9. Check readiness, tick Reviewed, Approve.
10. On the primary person, select Draft outreach, edit it, and approve it.
11. Sending remains locked until compliance setup is complete.

### Flow B — known company with ATS

1. Discover → Job board.
2. Choose provider and board identifier; optionally choose existing company.
3. Start research; open the Review queue.
4. The hiring checklist is complete from the ATS evidence.
5. Complete company/person/email checks and final review.

### Flow C — CSV seed

1. Discover → Import CSV → choose file.
2. Inspect the five-row preview and all automatic column mappings.
3. Import and see inserted/updated/contact/skipped counts.
4. Review defaults to Unreviewed.
5. Each row still requires source research, contact confirmation, and review.

### Flow D — email fails verification

1. Primary person has an address; select Verify.
2. Result is Invalid.
3. Address is blocked and retained in history.
4. Research another work route or choose another decision-maker.
5. If only an Accept-all route remains, retain it for review/research; it cannot satisfy send readiness. A personal/generic fallback must still separately verify `valid` and have a confirmed reason.

### Flow E — no response, advance alternate

1. Open Sent draft after the no-response period.
2. Mark No response.
3. Return to Review and choose a different person.
4. Make that person primary; the old contact/outcome remains in history.
5. Confirm employment and verify the new primary’s route fresh.
6. Generate, edit, and separately approve a new draft.

### Flow F — conflicted evidence

1. Queue row shows two conflicts.
2. Open the Evidence tab or select Conflicts resolved in the readiness strip.
3. Compare source values/timestamps.
4. Keep current, use candidate, or Research further; enter the required note.
5. Company approval remains blocked while any conflict stays open/researching.

## 10. UX acceptance criteria

The interface is ready for a 100-company pilot when:

- a new owner can import or discover records without documentation;
- every automated fact can reveal source and captured time within one interaction;
- one company can have several jobs and people without duplicating company rows;
- exactly one current primary contact is visually obvious;
- no LinkedIn credential/cookie or authenticated scrape control exists;
- invalid/stale/suppressed emails cannot appear send-ready;
- final review records the checkbox, decision, notes, and time;
- the next unresolved record is one action away;
- draft facts can be traced to stored company/job evidence;
- incomplete compliance visibly locks Gmail sending;
- reconnecting Gmail requires a new successful test-to-self before sending can be enabled;
- backup inspection/typed restore and recovery-before-delete are available without opening SQLite manually;
- keyboard-only review and 200% zoom are usable;
- refresh/back/forward preserve the queue context;
- empty, loading, failure, and partial-success states are designed;
- a 10,000-row synthetic queue remains responsive through 100-row server pagination; and
- the UI uses the same small component set and status vocabulary everywhere.
