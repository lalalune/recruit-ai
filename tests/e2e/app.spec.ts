import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

interface CompanyFixture {
  id: string;
  name: string;
}

interface DraftFixture {
  id: string;
  companyName: string;
  status: string;
}

const routes = [
  { path: "/discover", heading: "Discover" },
  { path: "/review", heading: "Review" },
  { path: "/outreach", heading: "Outreach" },
  { path: "/settings", heading: "Settings" },
] as const;

async function apiData<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  const payload = (await response.json()) as { data?: T; error?: string };
  if (!response.ok() || payload.data === undefined) {
    throw new Error(
      `Fixture request failed (${response.status()} ${path}): ${
        payload.error || JSON.stringify(payload)
      }`,
    );
  }
  return payload.data;
}

async function companies(request: APIRequestContext) {
  return apiData<CompanyFixture[]>(
    request,
    "/api/companies?limit=100&offset=0&sort=name",
  );
}

async function drafts(request: APIRequestContext) {
  return apiData<DraftFixture[]>(
    request,
    "/api/outreach/drafts?view=all&limit=100&offset=0",
  );
}

function companyByName(items: CompanyFixture[], name: string) {
  const company = items.find((item) => item.name === name);
  if (!company) throw new Error(`Missing company fixture: ${name}`);
  return company;
}

function draftByStatus(items: DraftFixture[], status: string) {
  const draft = items.find((item) => item.status === status);
  if (!draft) throw new Error(`Missing outreach fixture with status: ${status}`);
  return draft;
}

async function expectCompanyWorkspace(
  page: Page,
  company: CompanyFixture,
) {
  await expect(page).toHaveURL(new RegExp(`/review/${company.id}`));
  await expect(page.locator(".record-title-row h2")).toHaveText(company.name);
}

async function switchCompany(page: Page, company: CompanyFixture) {
  await page.locator(".queue-row", { hasText: company.name }).click();
  await expectCompanyWorkspace(page, company);
}

test.describe("RecruitAI browser workflows", () => {
  for (const route of routes) {
    test(`${route.heading} renders without browser errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));

      await page.goto(route.path);
      await expect(
        page.getByRole("heading", { level: 1, name: route.heading }),
      ).toBeVisible();
      await page.waitForLoadState("networkidle");

      expect(errors).toEqual([]);
    });
  }

  test("CSV import reports inserted, updated, contact, and skipped totals", async ({
    page,
  }, testInfo) => {
    const retrySuffix = testInfo.retry ? `-${testInfo.retry}` : "";
    await page.goto("/discover");
    await page.getByRole("button", { name: "Import CSV" }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "e2e-startups.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        [
          "company_name,website_url,location,full_name,title,email",
          `E2E Photon Labs${retrySuffix},https://e2e-photon${retrySuffix}.example,San Francisco CA,Jordan Lee,COO,jordan@e2e-photon${retrySuffix}.example`,
        ].join("\n"),
      ),
    });

    await expect(page.getByText("First 1 rows", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Import 1 records" }).click();
    await expect(
      page.getByRole("status").filter({
        hasText:
          "Import complete: 1 companies added, 0 updated, 1 contacts retained, and 0 rows skipped.",
      }),
    ).toBeVisible();
  });

  test("Review filters survive Back, Forward, and reload", async ({ page }) => {
    const initial =
      "/review?view=all&hiring=false&priority=high&sort=name&q=Northstar";
    await page.goto(initial);

    const view = page.getByLabel("Review view");
    const priority = page.getByLabel("Priority");
    await expect(page.getByLabel("Search companies")).toHaveValue("Northstar");
    await expect(view).toHaveValue("all");
    await expect(priority).toHaveValue("high");
    await expect(page.getByRole("checkbox", { name: "Hiring only" })).not.toBeChecked();

    await view.selectOption("needs_research");
    await expect(page).toHaveURL(/view=needs_research/);
    await priority.selectOption("low");
    await expect(page).toHaveURL(/priority=low/);

    await page.goBack();
    await expect(view).toHaveValue("needs_research");
    await expect(priority).toHaveValue("high");

    await page.goBack();
    await expect(view).toHaveValue("all");
    await expect(priority).toHaveValue("high");

    await page.goForward();
    await expect(view).toHaveValue("needs_research");
    await expect(priority).toHaveValue("high");

    await page.reload();
    await expect(page.getByLabel("Search companies")).toHaveValue("Northstar");
    await expect(view).toHaveValue("needs_research");
    await expect(priority).toHaveValue("high");
    await expect(page.getByLabel("Sort companies")).toHaveValue("name");
  });

  test("canceled Review dialogs do not leak values between companies", async ({
    page,
    request,
  }) => {
    const items = await companies(request);
    const northstar = companyByName(items, "Northstar Robotics");
    const tandem = companyByName(items, "Tandem Compute");
    await page.goto(`/review/${northstar.id}?view=all&hiring=false`);
    await expectCompanyWorkspace(page, northstar);

    await page.getByRole("tab", { name: /Evidence/ }).click();
    await page.getByRole("button", { name: "Add evidence" }).click();
    let dialog = page.getByRole("dialog", { name: "Add research evidence" });
    await dialog.getByLabel("Observed value").fill("Northstar-only value");
    await dialog.getByLabel("Source URL").fill("https://northstar.example/proof");
    await dialog.getByLabel("Short excerpt or note").fill("Northstar-only excerpt");
    await dialog
      .getByRole("checkbox", {
        name: "I checked this source and confirmed the fact",
      })
      .click();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await switchCompany(page, tandem);
    await page.getByRole("tab", { name: /Evidence/ }).click();
    await page.getByRole("button", { name: "Add evidence" }).click();
    dialog = page.getByRole("dialog", { name: "Add research evidence" });
    await expect(dialog.getByLabel("Record")).toHaveValue(tandem.id);
    await expect(dialog.getByLabel("Observed value")).toHaveValue("");
    await expect(dialog.getByLabel("Source URL")).toHaveValue("");
    await expect(dialog.getByLabel("Short excerpt or note")).toHaveValue("");
    await expect(
      dialog.getByRole("checkbox", {
        name: "I checked this source and confirmed the fact",
      }),
    ).not.toBeChecked();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("tab", { name: "Company" }).click();
    await page.getByRole("button", { name: "Add live job" }).click();
    dialog = page.getByRole("dialog", { name: "Add live job" });
    await dialog.getByLabel("Job title").fill("Tandem-only role");
    await dialog.getByLabel("Location").fill("Oakland");
    await dialog
      .getByRole("checkbox", { name: "No public URL is available" })
      .click();
    await dialog
      .getByRole("checkbox", {
        name: "I confirmed this source says the company is currently hiring",
      })
      .click();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await switchCompany(page, northstar);
    await page.getByRole("button", { name: "Add live job" }).click();
    dialog = page.getByRole("dialog", { name: "Add live job" });
    await expect(dialog.getByLabel("Job title")).toHaveValue("");
    await expect(dialog.getByLabel("Location")).toHaveValue("");
    await expect(
      dialog.getByRole("checkbox", { name: "No public URL is available" }),
    ).not.toBeChecked();
    await expect(
      dialog.getByRole("checkbox", {
        name: "I confirmed this source says the company is currently hiring",
      }),
    ).not.toBeChecked();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Exclude", exact: true }).click();
    dialog = page.getByRole("dialog", { name: `Exclude ${northstar.name}` });
    await dialog.getByLabel("Reason").selectOption("other");
    await dialog.getByLabel("Required note").fill("Northstar-only exclusion note");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await switchCompany(page, tandem);
    await page.getByRole("button", { name: "Exclude", exact: true }).click();
    dialog = page.getByRole("dialog", { name: `Exclude ${tandem.name}` });
    await expect(dialog.getByLabel("Reason")).toHaveValue("not_hiring");
    await expect(dialog.getByLabel("Note")).toHaveValue("");
  });

  test("Review tabs expose keyboard tab behavior", async ({ page, request }) => {
    const northstar = companyByName(
      await companies(request),
      "Northstar Robotics",
    );
    await page.goto(`/review/${northstar.id}?view=all&hiring=false`);
    const companyTab = page.getByRole("tab", { name: "Company" });
    const peopleTab = page.getByRole("tab", { name: /People/ });
    const historyTab = page.getByRole("tab", { name: "History" });

    await companyTab.focus();
    await companyTab.press("ArrowRight");
    await expect(peopleTab).toBeFocused();
    await expect(peopleTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toHaveAccessibleName(/People/);

    await peopleTab.press("End");
    await expect(historyTab).toBeFocused();
    await expect(historyTab).toHaveAttribute("aria-selected", "true");

    await historyTab.press("Home");
    await expect(companyTab).toBeFocused();
    await expect(companyTab).toHaveAttribute("aria-selected", "true");
  });

  test("a direct sent-history URL never falls back to an active draft", async ({
    page,
    request,
  }) => {
    const sent = draftByStatus(await drafts(request), "sent");
    await page.goto(`/outreach/${sent.id}`);

    await expect(page).toHaveURL(new RegExp(`/outreach/${sent.id}`));
    await expect(page.locator(".draft-title-row h2")).toHaveText(sent.companyName);
    await expect(page.locator(".draft-title-row .badge")).toHaveText("Sent");
    await expect(
      page.locator(".draft-queue-row", { hasText: sent.companyName }),
    ).toHaveCount(0);
  });

  test("send_unknown presents explicit, note-gated resolution choices", async ({
    page,
    request,
  }) => {
    const unknown = draftByStatus(await drafts(request), "send_unknown");
    await page.goto(`/outreach/${unknown.id}`);
    await expect(
      page.getByText("Gmail delivery could not be confirmed.", { exact: false }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Found in Sent" }).click();
    let dialog = page.getByRole("dialog", {
      name: "Confirm message was sent",
    });
    const recordResolution = dialog.getByRole("button", {
      name: "Record resolution",
    });
    await expect(recordResolution).toBeDisabled();
    await dialog
      .getByLabel("Gmail check note")
      .fill("Checked the E2E Sent folder fixture.");
    await expect(recordResolution).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Confirm not sent" }).click();
    dialog = page.getByRole("dialog", {
      name: "Confirm message was not sent",
    });
    await expect(dialog.getByLabel("Gmail check note")).toHaveValue("");
    await expect(
      dialog.getByRole("button", { name: "Record resolution" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("owner review flows through message editing and explicit draft approval", async ({
    page,
    request,
  }) => {
    const arc = companyByName(await companies(request), "Arc Materials");
    const arcDraft = (await drafts(request)).find(
      (draft) => draft.companyName === arc.name && draft.status === "draft",
    );
    if (!arcDraft) throw new Error("Missing Arc Materials draft fixture.");

    await page.goto(`/review/${arc.id}?view=all&hiring=false`);
    await expectCompanyWorkspace(page, arc);
    await page.getByRole("checkbox", { name: "Reviewed" }).click();
    const reviewResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/companies/${arc.id}/review`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    expect((await reviewResponse).ok()).toBe(true);

    await page.goto(`/outreach/${arcDraft.id}`);
    await expect(page.locator(".draft-title-row h2")).toHaveText(arc.name);
    await page.getByLabel("Subject").fill("Materials hiring support for Arc");
    await page
      .getByLabel("Body")
      .fill(
        "Hi Sam,\n\nI reviewed Arc Materials’ current research and manufacturing openings. We work on contingency and can introduce carefully matched candidates for those searches.\n\nBest,\nRecruitAI owner",
      );
    const draftResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/outreach/drafts/${arcDraft.id}`) &&
        response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Approve draft" }).click();
    expect((await draftResponse).ok()).toBe(true);

    await expect(page.locator(".draft-title-row .badge")).toHaveText("Approved");
    await expect(
      page.getByText("Message manually edited and explicitly approved"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send now with Gmail" }),
    ).toBeDisabled();
  });

  test("Settings credential dialogs discard canceled secrets", async ({
    page,
  }) => {
    await page.goto("/settings");

    const apollo = page.locator(".connection-row", { hasText: "Apollo" });
    await apollo.getByRole("button", { name: "Add key" }).click();
    let dialog = page.getByRole("dialog", { name: "Configure Apollo" });
    await dialog.getByLabel("API key").fill("e2e-secret-that-must-clear");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await apollo.getByRole("button", { name: "Add key" }).click();
    dialog = page.getByRole("dialog", { name: "Configure Apollo" });
    await expect(dialog.getByLabel("API key")).toHaveValue("");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Add credentials" }).click();
    dialog = page.getByRole("dialog", { name: "Google OAuth credentials" });
    await dialog.getByLabel("OAuth client ID").fill("e2e.apps.googleusercontent.com");
    await dialog.getByLabel("OAuth client secret").fill("e2e-google-secret");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Add credentials" }).click();
    dialog = page.getByRole("dialog", { name: "Google OAuth credentials" });
    await expect(dialog.getByLabel("OAuth client ID")).toHaveValue("");
    await expect(dialog.getByLabel("OAuth client secret")).toHaveValue("");
  });

  test("mobile Outreach provides a working return to the draft queue", async ({
    page,
    request,
  }) => {
    const sent = draftByStatus(await drafts(request), "sent");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/outreach/${sent.id}`);

    const back = page.getByRole("link", { name: "Drafts", exact: true });
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/\/outreach$/);
    await expect(page.locator(".draft-queue")).toBeVisible();
    await expect(page.locator(".draft-workspace-panel")).toBeHidden();
  });

  test("primary routes pass automated WCAG A and AA scans", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const route of routes) {
      await page.goto(route.path);
      await expect(
        page.getByRole("heading", { level: 1, name: route.heading }),
      ).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(
        results.violations,
        `${route.path}: ${results.violations
          .map((violation) => `${violation.id} (${violation.nodes.length})`)
          .join(", ")}`,
      ).toEqual([]);
    }
  });

  test("primary routes do not create document-level horizontal overflow", async ({
    page,
  }) => {
    const widths = [320, 760, 761, 980, 981, 1180, 1181, 1440];
    const failures: string[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of routes) {
        await page.goto(route.path);
        await expect(
          page.getByRole("heading", { level: 1, name: route.heading }),
        ).toBeVisible();
        const overflow = await page.evaluate(() => {
          const documentWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
          );
          const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                selector:
                  element.id ||
                  element.className ||
                  element.tagName.toLowerCase(),
                left: Math.round(rect.left),
                right: Math.round(rect.right),
              };
            })
            .filter(
              (element) =>
                element.right > window.innerWidth + 1 || element.left < -1,
            )
            .sort(
              (left, right) =>
                right.right -
                window.innerWidth -
                (left.right - window.innerWidth),
            )
            .slice(0, 5);
          return {
            amount: documentWidth - window.innerWidth,
            documentWidth,
            offenders,
            viewportWidth: window.innerWidth,
          };
        });
        if (overflow.amount > 1) {
          failures.push(
            `${route.path} at ${width}px rendered ${overflow.documentWidth}px wide; offenders: ${JSON.stringify(
              overflow.offenders,
            )}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
