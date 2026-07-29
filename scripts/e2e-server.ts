import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "recruitai-e2e-"));
const liveCredentialKeys = [
  "APOLLO_API_KEY",
  "HUNTER_API_KEY",
  "ZEROBOUNCE_API_KEY",
  "SOCRATA_APP_TOKEN",
  "BRAVE_SEARCH_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
] as const;

process.env.RECRUITAI_DATA_DIR = dataDir;
process.env.RECRUITAI_DEV = "0";
process.env.RECRUITAI_NO_OPEN = "1";
for (const key of liveCredentialKeys) delete process.env[key];

const { loadDemoWorkspace } = await import("../src/server/discovery");
const { generateDraft } = await import("../src/server/drafting");
const {
  getCompany,
  listCompanies,
  markDraftSendUnknown,
  markDraftSent,
} = await import("../src/server/repository");
const databaseModule = await import("../src/server/database");

loadDemoWorkspace();

const fixtures = listCompanies({ limit: 20, offset: 0, sort: "name" }).items;
const draftFor = (companyName: string) => {
  const item = fixtures.find((company) => company.name === companyName);
  if (!item) throw new Error(`Missing E2E company fixture: ${companyName}`);
  const company = getCompany(item.id);
  const contact = company?.contacts.find((candidate) => candidate.status === "primary");
  if (!company || !contact) {
    throw new Error(`Missing E2E primary contact fixture: ${companyName}`);
  }
  const draft = generateDraft(company.id, contact.id, "concise");
  if (!draft) throw new Error(`Could not create E2E draft fixture: ${companyName}`);
  return draft;
};

const sentDraft = draftFor("Northstar Robotics");
databaseModule
  .getDatabase()
  .query("UPDATE outreach_drafts SET status = 'sending' WHERE id = ?")
  .run(sentDraft.id);
markDraftSent(sentDraft.id, "e2e-sent-message", "e2e-sent-thread");

const unknownDraft = draftFor("Tandem Compute");
databaseModule
  .getDatabase()
  .query("UPDATE outreach_drafts SET status = 'sending' WHERE id = ?")
  .run(unknownDraft.id);
markDraftSendUnknown(unknownDraft.id, "Synthetic E2E ambiguous delivery");

draftFor("Arc Materials");

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    databaseModule.closeDatabase();
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
}

process.once("exit", cleanup);
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));

console.log(`RecruitAI E2E data: ${dataDir}`);
await import("../src/server/index");
