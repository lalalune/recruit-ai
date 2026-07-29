import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, resetDatabaseForTests } from "../src/server/database";
import {
  addContact,
  getDashboardSummary,
  listCompanies,
  upsertCompany,
  upsertJob,
} from "../src/server/repository";

const dataDirectory = mkdtempSync(path.join(tmpdir(), "recruit-ai-scale-"));
const startedAt = performance.now();

try {
  const database = resetDatabaseForTests(dataDirectory);
  database.transaction(() => {
    for (let index = 0; index < 10_000; index++) {
      const number = String(index).padStart(5, "0");
      const company = upsertCompany({
        name: `Scale Fixture ${number}`,
        domain: `scale-${number}.example`,
        websiteUrl: `https://scale-${number}.example`,
        description: `Synthetic Bay Area technology company ${number}.`,
        location: index % 2 === 0 ? "San Francisco, CA" : "Oakland, CA",
        employeeCountMin: 3 + (index % 500),
        employeeCountMax: 3 + (index % 500),
        industries: index % 3 === 0 ? ["AI", "Data"] : ["Robotics", "Hardware"],
        status: "ready_for_review",
        priority: index % 5 === 0 ? "high" : "medium",
      });
      upsertJob({
        companyId: company.id,
        externalId: `job-${number}`,
        title: index % 2 === 0 ? "Machine Learning Engineer" : "Operations Lead",
        location: "San Francisco Bay Area",
        sourceType: "scale_fixture",
        postedAt: new Date().toISOString(),
        url: `https://scale-${number}.example/jobs/1`,
      });
      addContact(company.id, {
        fullName: `Decision Maker ${number}`,
        title: index % 10 === 0 ? "Founder & CEO" : "Head of People",
        email: `person-${number}@scale-${number}.example`,
        emailType: "work",
        emailStatus: "valid",
        emailVerifiedAt: new Date().toISOString(),
        rank: 1,
        status: "primary",
      });
    }
  })();

  const writeMs = performance.now() - startedAt;
  const queryStartedAt = performance.now();
  const dashboard = getDashboardSummary();
  const page = listCompanies({
    reviewed: "false",
    hasOpenRoles: "true",
    limit: 100,
    offset: 0,
  });
  const queryMs = performance.now() - queryStartedAt;
  if (
    dashboard.companies !== 10_000 ||
    dashboard.contacts !== 10_000 ||
    dashboard.openRoles !== 10_000 ||
    page.items.length !== 100 ||
    page.total !== 10_000
  ) {
    throw new Error(
      `Scale verification failed: ${JSON.stringify({
        dashboard,
        pageItems: page.items.length,
        pageTotal: page.total,
      })}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        companies: dashboard.companies,
        contacts: dashboard.contacts,
        openRoles: dashboard.openRoles,
        writeSeconds: Number((writeMs / 1_000).toFixed(2)),
        queueQueryMilliseconds: Number(queryMs.toFixed(2)),
      },
      null,
      2,
    ),
  );
} finally {
  closeDatabase();
  if (dataDirectory.startsWith(path.join(tmpdir(), "recruit-ai-scale-"))) {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}
