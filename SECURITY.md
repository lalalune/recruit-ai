# Security policy

RecruitAI stores API keys, OAuth tokens, public-page snapshots, professional contact information, and outreach history on the local machine. Treat the local data directory and its backups as sensitive.

## Reporting a vulnerability

Do not open a public issue for a vulnerability or include real credentials/data in a report. Use GitHub’s private vulnerability-reporting or Security Advisory flow for this repository. Include:

- affected version/commit and operating system;
- reproduction steps using fictional data;
- impact and required preconditions;
- whether secrets or personal information could be exposed; and
- a suggested mitigation, if known.

If private reporting is unavailable, open a public issue containing no exploit details or sensitive data and ask the maintainer for a private contact channel.

## Supported versions

Until the first stable release, only the current default branch is supported. There is no security SLA. Critical fixes should be applied before continuing source runs or outreach.

## Security model

RecruitAI is a single-owner, local application:

- the API binds to `127.0.0.1` by default;
- API requests reject non-loopback `Host` and `Origin` values to reduce DNS-rebinding risk;
- state-changing API calls require an application client header;
- SQLite and evidence files remain on the local machine unless the owner exports or backs them up;
- provider secrets may come from environment variables or the `secrets` table in the Git-ignored local SQLite database;
- public website research rejects private/local/reserved network destinations, pins a validated DNS result to each bounded outbound request, and revalidates every redirect; and
- implemented Gmail sending is explicit and one-at-a-time, with review, self-test, compliance, freshness, suppression, schedule, and rate gates.

This is defense in depth, not a sandbox. Anyone who can run code as the same OS user can generally access that user’s local files and process environment. Use a locked, encrypted OS account.

## Secrets

- Never commit `.env`, the local SQLite database/data directory, OAuth refresh tokens, browser profiles, or provider payloads.
- Do not paste LinkedIn or other authenticated-session cookies into the product; no such workflow is supported.
- Environment variables are convenient for development but can be visible to same-user processes.
- The current SQLite fallback stores provider keys and the Gmail refresh token without application-level encryption. Protect the OS account, data directory, and every full backup; backups contain the same credentials.
- Distributed desktop builds should migrate API keys and OAuth refresh tokens to macOS Keychain, Windows Credential Manager, or Linux Secret Service.
- Removing a provider connection deletes the local credential without deleting evidence history. Revoke the credential at the provider as well when compromise or complete deauthorization is required.

Rotate a credential immediately if it appears in a terminal transcript, log, issue, commit, artifact, or backup shared outside the owner’s control. Purging it from Git history does not make the old credential safe.

## Local service

Do not change the default bind address to `0.0.0.0` or expose the local API through a tunnel without designing authentication, authorization, TLS, and cross-origin protections. The custom local client header is not sufficient for an Internet-facing service.

All state-changing routes should:

- reject requests without the client guard;
- validate structured input;
- return `no-store`;
- avoid reflecting secrets;
- enforce entity and review invariants server-side; and
- write material changes to the audit trail.

## Public-site research

Any crawler or browser fallback must:

- permit only public HTTP(S);
- resolve and block loopback, private, link-local, and local-name destinations, including redirects;
- guard against DNS rebinding;
- honor `robots.txt` and source policy;
- cap pages, bytes, redirects, concurrency, and time;
- parse only expected content types;
- identify the research user agent;
- avoid login, CAPTCHA, and access-control bypass; and
- store snapshots only in the ignored local data directory.

HTML snapshots and excerpts are untrusted. Never execute captured script, interpolate it into SQL, or render it as unsanitized application HTML.

## SQLite, exports, and backups

- Keep foreign keys enabled and use transactions for related writes.
- Use parameterized statements.
- Do not copy a live database as if the main file were necessarily complete; macOS/Linux writes may still be in the WAL.
- Validate backup format and migration version before restore.
- Create a pre-restore backup and resolve the exact data path before deletion.
- Encrypt backups containing company/contact data.
- Neutralize formula-leading CSV cells to prevent spreadsheet execution.
- The current send path serializes requests, rechecks suppression and company outreach history immediately before it atomically claims an approved draft as `sending`, and blocks blind retry when delivery is ambiguous.

## Gmail

Use Google’s installed-app OAuth flow and the minimum scope required. Never store a Gmail password, app password, or browser cookie. A refresh token is a high-value secret.

Sending must fail closed when:

- compliance identity/footer settings are incomplete;
- the message or record lacks explicit approval;
- email verification is stale or disallowed;
- a suppression exists;
- an hourly/daily limit is reached;
- the connected OAuth account identity is missing or cannot be confirmed; or
- the provider result is ambiguous enough that retry could double-send.

On success, Gmail message/thread IDs and send state are persisted. A definitive pre-acceptance failure can release the claim; an ambiguous result becomes `send_unknown` and requires checking Gmail rather than automatic retry.

## Out of scope

The project does not claim to protect against:

- a compromised OS account or malicious administrator;
- malware with access to the owner’s files/processes;
- a malicious provider;
- errors in third-party data; or
- legal or policy risk created by the owner’s use of exported data.
