# RecruitAI

RecruitAI is a local-first research and review workbench for finding San Francisco Bay Area technology startups that are hiring, identifying the most relevant decision-maker, validating one contact route, and preparing individually reviewed contingency-recruiting outreach.

It is intentionally not a bulk-email engine or an authenticated social-platform scraper. Company data, evidence, credentials, snapshots, and drafts stay in a Git-ignored local data directory.

## What it is designed to do

- Discover Bay Area company seeds from permitted public sources and licensed APIs.
- Detect current hiring through company careers pages and public Greenhouse, Lever, and Ashby job-board APIs.
- Keep Hacker News hiring posts as lead/prioritization signals without harvesting comment emails; confirm hiring on a company site, supported ATS, or owner-reviewed manual source before approval.
- Research queued public company sites in bounded three-at-a-time batches, detect supported ATS links, ingest their public jobs, respect `robots.txt`, and block private-network destinations.
- Resolve missing official domains through the licensed Brave Search API when the owner supplies a key.
- Rank founder, operations, people, talent, and functional leaders by company size.
- Use Apollo people search to rank candidates, enrich only the current primary, never request personal email or phone, and leave all returned email unverified.
- Find and verify the selected email through Hunter.
- Require explicit Bay Area, 3–1,000 employee, technology, outside-recruiting-fit, recently observed hiring, current company evidence, current-employment, and contact-route checks.
- Preserve sources, freshness, conflicts and their resolutions, edits, review decisions, outreach outcomes, and suppression history in SQLite.
- Generate editable drafts tailored to company size, sector, and open roles.
- Export a formula-safe CSV.

The workflow is evidence-first:

`discover → qualify hiring → research → select one person → verify → review → draft → approve`

The app can send exactly one approved message at a time through the official Gmail API. Sending stays locked until sender identity, postal address, opt-out handling, Gmail OAuth, a successful test message to the connected account, fresh verification, suppression checks, and explicit company, contact, and message review are complete. Replies, bounces, and no-response outcomes can be recorded manually; there is no unattended send-all workflow, scheduler, Gmail read scope, reply reader, or bounce poller. See the [research and implementation plan](docs/RESEARCH_PLAN.md).

The current default hiring window is 180 days. Active roles observed in the most recent 45 days receive the stronger “fresh” score; older roles can still count until their latest observation leaves the configured 30–180 day hiring window. Approval also requires at least one company-site, supported-ATS, or owner-confirmed manual role observed inside both that hiring window and the separate refresh target (default 90 days), plus company evidence captured inside the evidence-age limit (default 180 days). Hacker News remains a lead signal until confirmed through one of those routes. A primary decision-maker’s reviewed title/employment observation must be no more than six months old. A `valid` email verification must be no more than the configured 1–30 days old before send.

## Explicit source boundaries

- **LinkedIn access is manual only.** The app may open a search and store a URL pasted by the owner; a licensed provider such as Apollo may also return a LinkedIn URL as unconfirmed provider evidence. RecruitAI never fetches that URL, accepts LinkedIn credentials/cookies, or scrapes authenticated pages, and the owner must still confirm the person/company association.
- **Y Combinator directories are manual only.** Use their public pages for owner-led research; do not automate directory extraction.
- **Company sites are public only.** The bounded HTTP crawler follows same-origin links, validates every redirect and DNS answer, pins the validated public address to the outbound connection, rejects private/link-local/reserved destinations, checks `robots.txt`, stores capped local snapshots, and can follow detected Greenhouse/Lever/Ashby board links through their public APIs. It has no authenticated or browser-automation fallback.
- **Phones are manual only.** A number is retained for use only when its existence and source are confirmed.
- **Invalid, disposable, do-not-mail, unverified, stale, catch-all, or unknown addresses are not send-ready.** A personal or generic route must separately verify `valid` and requires an explicit fallback reason/confirmation.

The detailed policy for every source is in [docs/RESEARCH_PLAN.md](docs/RESEARCH_PLAN.md#4-source-policy-matrix).

## Stack

- [Bun](https://bun.sh/) runtime, package manager, tests, SQLite driver, and executable compiler
- React + Vite
- Hono local API
- SQLite with FTS5; WAL on macOS/Linux and the rollback journal on native Windows
- Zod request validation
- Radix behavior primitives, Lucide icons, and a compact custom component layer

The production shape is a standalone local executable that binds to `127.0.0.1` and opens the interface in the system browser. PostgreSQL and a hosted backend are intentionally out of scope.

## Quick start

Requirements:

- Bun 1.3 or newer
- macOS, Windows, or Linux

```bash
git clone https://github.com/lalalune/recruit-ai.git
cd recruit-ai
bun install
cp .env.example .env
bun run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) for the development UI. The local API defaults to `http://127.0.0.1:4317`.

Provider keys are optional. Start with the fictional demo workspace or free/public sources, then add keys under Settings or in `.env`.

```dotenv
APOLLO_API_KEY=
HUNTER_API_KEY=
ZEROBOUNCE_API_KEY=
SOCRATA_APP_TOKEN=
BRAVE_SEARCH_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
RECRUITAI_PORT=4317
RECRUITAI_DATA_DIR=./data
```

Environment values override locally saved secrets. Never commit `.env` or files created under `data/`.

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | Start the API and Vite development server |
| `bun run start` | Start the Bun server directly |
| `bun run typecheck` | Run TypeScript checks |
| `bun test` | Run the test suite |
| `bun run benchmark:10k` | Build a temporary 10,000-company fixture and verify queue/dashboard queries |
| `bun run build` | Build the web UI |
| `bun run check` | Typecheck, test, and build |
| `bun run build:binary` | Build an executable for the current platform |
| `bun run build:binaries` | Cross-compile supported macOS, Windows, and Linux artifacts |

Compiled artifacts are written to `dist-bin/`. Cross-compilation does not sign or notarize a binary. Public distribution should add macOS notarization, Windows code signing, checksums, and release provenance.
The current cross-compile matrix is macOS arm64/x64, Windows x64, and Linux x64.

## Local data

Development data lives in `./data` by default:

```text
data/
  backups/
  recruit-ai.sqlite
  recruit-ai.sqlite-wal
  recruit-ai.sqlite-shm
  snapshots/
```

Everything except the directory README and `.gitkeep` is ignored by Git. The SQLite database contains company/contact data, evidence metadata, conflicts, reviews, drafts and outcomes, suppressions, audit history, API keys, and the Gmail refresh token. Public-page snapshots, provider evidence, and backups may contain personal information. Full backups also include locally saved provider credentials and the Gmail token because those live in SQLite; treat every backup as a secret-bearing sensitive file. Packaged binaries use the operating system’s per-user application-data directory instead of the source checkout.

On macOS and Linux, RecruitAI enforces owner-only permissions on the data, snapshot, and backup directories (`0700`) and on SQLite/snapshot/backup files it creates (`0600`). Windows relies on the current user’s application-data ACLs.

Use **Settings → Local data → Create backup** for a full-fidelity JSON backup containing a checkpointed SQLite database and current snapshot files. Restore first validates the format, version, required tables, safe snapshot paths, and SQLite integrity, then creates a pre-restore safety backup before atomically replacing both the database and snapshot set. **Download backup** copies the selected artifact outside the app data directory. Do not copy only `recruit-ai.sqlite` while the application is running; on macOS/Linux, current writes may still be in the WAL. Stop the app first if performing a manual filesystem copy. Encrypt off-device backups and keep them outside a synced public repository.

CSV export includes stable IDs; company qualification and score components; roles/conflict/suppression indicators; selected contact, fallback, phone, and employment proof; verification/review/outreach state; notes; and evidence URLs. It is formula-safe but intentionally flattened rather than a full database backup. Exporting data does not make a contact eligible for outreach.

## Configuration and cost

The useful low-cost order is:

1. qualify companies with public job/careers sources;
2. identify up to three names but select one primary;
3. enrich only the primary;
4. verify only the selected address;
5. pay for an alternate after a documented later round.

This avoids paying to enrich three people at all 10,000 companies. A saved key means only that the provider is configured; use **Test connection** before a run, and confirm that the purchased plan permits the exact endpoint, fields, storage, and retention required. Apollo’s test validates authentication but cannot prove all endpoint entitlements or remaining credits. Hunter Finder/Verifier credits vary by product/plan, Brave charges per search request and has plan-dependent result-storage rights, and ZeroBounce is optional. Provider prices and credit models change; the [cost model](docs/RESEARCH_PLAN.md#7-cost-model) records the checked July 2026 assumptions and links to official provider pages.

## Product and UX documents

- [Research and implementation plan](docs/RESEARCH_PLAN.md) — source research, policies, costs, Gmail architecture, local data model, phases, tests, and acceptance criteria
- [Queue-first UX specification](docs/UX_FLOW.md) — three route comparison and the full page/control/interaction contract
- [Data dictionary](docs/DATA_DICTIONARY.md) — SQLite entities, state semantics, import rules, and exact CSV columns
- [Product principles](PRODUCT.md) — audience, purpose, personality, and design constraints
- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)

## Responsible use

This repository is for lawful, owner-reviewed internal research. You are responsible for source contracts, privacy obligations, commercial-email law, provider policies, and the messages you send. “Personal use” does not authorize bypassing access controls or copying authenticated cookies, and “B2B” does not by itself remove commercial-email requirements.

Do not submit changes that add credential theft, cookie importing, CAPTCHA bypass, stealth automation, rate-limit evasion, automatic phone harvesting, or unattended bulk sending.

## License

[MIT](LICENSE). The software license does not grant rights to third-party data, APIs, websites, brands, or personal information.
