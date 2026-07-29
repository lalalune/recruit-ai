import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const binaryArgument = process.argv[2];
if (!binaryArgument) {
  throw new Error(
    "Usage: bun run scripts/smoke-binary.ts <path-to-current-platform-binary>",
  );
}

const binaryPath = path.resolve(binaryArgument);
if (!existsSync(binaryPath)) {
  throw new Error(`Binary not found: ${binaryPath}`);
}

const portReservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(null, { status: 503 }),
});
const port = portReservation.port;
await portReservation.stop(true);
const dataDir = mkdtempSync(path.join(tmpdir(), "recruit-ai-binary-smoke-"));
const baseUrl = `http://127.0.0.1:${port}`;

const child = Bun.spawn([binaryPath], {
  cwd: path.dirname(binaryPath),
  env: {
    ...process.env,
    RECRUITAI_DATA_DIR: dataDir,
    RECRUITAI_NO_OPEN: "1",
    RECRUITAI_PORT: String(port),
  },
  stdout: "pipe",
  stderr: "pipe",
});
const stdout = new Response(child.stdout).text();
const stderr = new Response(child.stderr).text();

async function waitForHealth() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Binary exited before becoming healthy (code ${child.exitCode}).`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return (await response.json()) as {
          data?: { ok?: boolean; version?: string; runtime?: string };
        };
      }
      lastError = new Error(`Health endpoint returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Binary did not become healthy within five seconds.");
}

try {
  const health = await waitForHealth();
  if (health.data?.ok !== true || health.data.version !== "0.1.0") {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }

  const appRoutes = [
    "/",
    "/discover",
    "/review",
    "/review/smoke-company",
    "/outreach",
    "/outreach/smoke-draft",
    "/settings?gmail=connected",
  ];
  for (const route of appRoutes) {
    const appResponse = await fetch(`${baseUrl}${route}`);
    const html = await appResponse.text();
    if (!appResponse.ok || !html.includes('id="root"')) {
      throw new Error(
        `The embedded frontend did not return the RecruitAI app shell for ${route}.`,
      );
    }
  }

  console.log(
    `Smoke test passed at ${baseUrl}: ${health.data.runtime}; embedded frontend loaded on ${appRoutes.length} direct routes.`,
  );
} catch (error) {
  child.kill();
  await child.exited;
  const output = [await stdout, await stderr].filter(Boolean).join("\n");
  if (output) console.error(output.trim());
  throw error;
} finally {
  if (child.exitCode === null) child.kill();
  await child.exited;
  if (dataDir.startsWith(path.join(tmpdir(), "recruit-ai-binary-smoke-"))) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
