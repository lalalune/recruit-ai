# Contributing

Thanks for helping improve RecruitAI. Keep changes focused on a local, evidence-backed, human-reviewed research workflow.

## Set up

```bash
bun install
cp .env.example .env
bun run dev
```

Before opening a pull request, run the same local gates used by the release
workflow. The browser installation is needed once per Playwright version:

```bash
bun install --frozen-lockfile
bun audit
bun run check
bun run test:coverage
bun run benchmark:10k
bun run test:e2e:install
bun run test:e2e
bun run build:binary
bun run smoke:binary
```

## Pull requests

- Keep one coherent change per pull request.
- Explain the user outcome, implementation, test coverage, data/schema impact, and any provider-policy impact.
- Add or update deterministic fixtures for source adapters; do not call paid/live providers in unit tests.
- Update `docs/RESEARCH_PLAN.md` when adding a source, changing retention/freshness, or altering Gmail behavior.
- Update `docs/UX_FLOW.md` when a control or state changes materially.
- Include accessible labels, keyboard behavior, empty/loading/error states, and 200% zoom in UI work.
- Preserve existing user data through an explicit migration; never drop or rewrite a table silently.

## Maintainer release process

Release tags are accepted only from commits already on `main`. Before tagging:

1. update both `package.json` and `APP_VERSION` in `src/shared/version.ts`;
2. use the Bun version pinned by `.bun-version`;
3. run `bun run version:check` and the complete gate above from a clean checkout;
4. confirm provider fixtures contain no live data or credentials; and
5. create and push an annotated `v<version>` tag.

The tag workflow independently repeats the audit, test, coverage, build,
benchmark, browser, and version gates. It then builds and smoke-tests macOS
arm64/x64, Windows x64, and Linux x64 on matching native runners, packages the
tested executables, verifies the release checksums, and creates or updates an
**unsigned draft** GitHub release.

Review the workflow logs, every archive’s `README.txt`, `LICENSE`, and
`THIRD_PARTY_NOTICES.txt`, `manifest.json`, and `SHA256SUMS` before publishing.
The workflow refuses to replace a release that is already public. Do not
publish an unsigned draft as a trusted desktop release: macOS signing and
notarization, Windows code signing, and release provenance/attestation remain
separate release gates. When those systems are added, sign/notarize before the
archive-and-checksum stage, then smoke-test and verify those exact checksummed
outputs without rebuilding them afterward.

## Data and fixture rules

- Never commit `.env`, `data/`, SQLite files, snapshots, provider payloads, OAuth tokens, API keys, real company exports, or real personal information.
- Fixtures must be fictional and use reserved domains such as `.example`.
- Redact provider request/response examples.
- Keep evidence and audit history append-only unless a documented privacy deletion flow requires removal.
- CSV output must remain formula-safe.

## Source integrations

A new automated source needs:

1. an official documentation and terms link;
2. a source-policy mode;
3. a statement of which fields are retained;
4. rate, pagination, timeout, retry, and idempotency behavior;
5. freshness and conflict semantics;
6. deterministic fixtures for success, empty, malformed, rate-limited, and failed responses; and
7. a Settings-visible disable/remove path.

Do not contribute:

- authenticated LinkedIn scraping, LinkedIn cookie/profile import, or access-control bypass;
- scraping of YC directories;
- CAPTCHA solving, stealth/browser fingerprint evasion, or proxy rotation intended to evade restrictions;
- Google/Gmail password or cookie storage;
- automatic phone-number harvesting;
- guessed emails presented as verified;
- unattended bulk sending or a bypass for review, suppression, freshness, or compliance gates; or
- code that binds the local service to a public interface by default.

## Security

Validate all external input. Public crawlers must block private, loopback, link-local, and local-name destinations; apply response-size, page-count, content-type, robots, and timeout limits. Never log secrets. State-changing local API requests require the application’s client guard.

Report vulnerabilities through the process in [SECURITY.md](SECURITY.md), not a public issue.

## Style

- Prefer small, source-specific adapters and reusable UI components.
- Keep the queue-first information architecture; do not create a new primary page for every entity.
- Use plain language and expose source/freshness beside decisions.
- Avoid dependencies when platform or existing project utilities are sufficient.
- Preserve WCAG 2.2 AA contrast and visible keyboard focus.

By contributing, you agree that your contribution is licensed under the repository’s [MIT License](LICENSE).
