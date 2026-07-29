import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_VERSION } from "../src/shared/version";

const projectRoot = path.resolve(import.meta.dir, "..");

function currentBinaryFilename() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "recruit-ai-macos-arm64";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "recruit-ai-macos-x64";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "recruit-ai-windows-x64.exe";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "recruit-ai-linux-x64";
  }
  throw new Error(
    `No smoke-test binary is defined for ${process.platform}/${process.arch}.`,
  );
}

function defaultBinaryPath() {
  const outputDir = path.resolve(import.meta.dir, "..", "dist-bin");
  const manifestPath = path.join(outputDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      "No binary path was supplied and dist-bin/manifest.json does not exist.",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    artifacts?: Array<{ filename?: unknown }>;
  };
  const expectedFilename = currentBinaryFilename();
  const artifact = manifest.artifacts?.find(
    (candidate) => candidate.filename === expectedFilename,
  );
  if (!artifact) {
    throw new Error(
      `dist-bin/manifest.json does not contain ${expectedFilename} for this host.`,
    );
  }
  return path.join(outputDir, expectedFilename);
}

const sourceBinaryPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : defaultBinaryPath();
if (
  !existsSync(sourceBinaryPath) ||
  !statSync(sourceBinaryPath).isFile()
) {
  throw new Error(`Binary not found: ${sourceBinaryPath}`);
}

const reservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(null, { status: 503 }),
});
const port = reservation.port;
await reservation.stop(true);

const smokeRoot = mkdtempSync(path.join(tmpdir(), "recruit-ai-binary-smoke-"));
const relativeToProject = path.relative(projectRoot, smokeRoot);
if (
  relativeToProject === "" ||
  (!relativeToProject.startsWith("..") && !path.isAbsolute(relativeToProject))
) {
  rmSync(smokeRoot, { recursive: true, force: true });
  throw new Error(
    "The binary smoke temporary directory resolved inside the source checkout.",
  );
}
const installDir = path.join(smokeRoot, "install");
const dataDir = path.join(smokeRoot, "data");
const fakeHome = path.join(smokeRoot, "home");
const fakeLocalAppData = path.join(smokeRoot, "local-app-data");
const fakeAppData = path.join(smokeRoot, "app-data");
const fakeXdgDataHome = path.join(smokeRoot, "xdg-data");
mkdirSync(installDir, { mode: 0o700 });
mkdirSync(dataDir, { mode: 0o700 });
mkdirSync(fakeHome, { mode: 0o700 });
mkdirSync(fakeLocalAppData, { mode: 0o700 });
mkdirSync(fakeAppData, { mode: 0o700 });
mkdirSync(fakeXdgDataHome, { mode: 0o700 });
const installedBinaryPath = path.join(
  installDir,
  path.basename(sourceBinaryPath),
);
copyFileSync(sourceBinaryPath, installedBinaryPath);
if (process.platform !== "win32") chmodSync(installedBinaryPath, 0o700);

const baseUrl = `http://127.0.0.1:${port}`;
const processOutput: string[] = [];
let activeChild: ReturnType<typeof Bun.spawn> | null = null;
let activeOutput: Promise<string[]> | null = null;

function expectedPackagedDataDir() {
  if (process.platform === "darwin") {
    return path.join(
      fakeHome,
      "Library",
      "Application Support",
      "RecruitAI",
    );
  }
  if (process.platform === "win32") {
    return path.join(fakeLocalAppData, "RecruitAI");
  }
  return path.join(fakeXdgDataHome, "recruit-ai");
}

function isolatedEnvironment(dataDirectory?: string) {
  const environment: Record<string, string> = {};
  const passthroughKeys = [
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "WINDIR",
  ];
  for (const key of passthroughKeys) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return {
    ...environment,
    APPDATA: fakeAppData,
    HOME: fakeHome,
    LOCALAPPDATA: fakeLocalAppData,
    RECRUITAI_NO_OPEN: "1",
    RECRUITAI_PORT: String(port),
    USERPROFILE: fakeHome,
    XDG_DATA_HOME: fakeXdgDataHome,
    ...(dataDirectory ? { RECRUITAI_DATA_DIR: dataDirectory } : {}),
  };
}

function startBinary(dataDirectory?: string) {
  const child = Bun.spawn([installedBinaryPath], {
    cwd: installDir,
    env: isolatedEnvironment(dataDirectory),
    stdout: "pipe",
    stderr: "pipe",
  });
  activeChild = child;
  activeOutput = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return child;
}

async function stopBinary(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode === null) child.kill();
  await child.exited;
  if (activeChild === child) {
    if (activeOutput) {
      processOutput.push(...(await activeOutput).filter(Boolean));
    }
    activeOutput = null;
    activeChild = null;
  }
}

async function waitForHealth(child: ReturnType<typeof Bun.spawn>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `Binary exited before becoming healthy (code ${child.exitCode}).`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        const payload = (await response.json()) as {
          data?: { ok?: boolean; version?: string; runtime?: string };
        };
        return { response, payload };
      }
      lastError = new Error(`Health endpoint returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Binary did not become healthy within six seconds.");
}

async function apiMutation(route: string, body: unknown, withHeader = true) {
  return fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withHeader ? { "X-RecruitAI-Client": "1" } : {}),
    },
    body: JSON.stringify(body),
  });
}

try {
  const first = startBinary(dataDir);
  const { response: healthResponse, payload: health } =
    await waitForHealth(first);
  if (health.data?.ok !== true || health.data.version !== APP_VERSION) {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }
  const requiredHeaders = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
  for (const [name, expected] of Object.entries(requiredHeaders)) {
    if (healthResponse.headers.get(name) !== expected) {
      throw new Error(`Missing packaged API security header ${name}.`);
    }
  }
  const rejectedOrigin = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "https://attacker.invalid" },
  });
  if (rejectedOrigin.status !== 403) {
    throw new Error("Packaged API accepted a non-loopback Origin.");
  }
  const missingClientHeader = await apiMutation(
    "/api/discovery/demo",
    {},
    false,
  );
  if (missingClientHeader.status !== 403) {
    throw new Error("Packaged API accepted a mutation without the client header.");
  }
  const seeded = await apiMutation("/api/discovery/demo", {});
  if (seeded.status !== 201) {
    throw new Error(`Packaged demo mutation returned ${seeded.status}.`);
  }
  const dashboardBeforeRestart = (await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json()) as { data?: { companies?: number } };
  if ((dashboardBeforeRestart.data?.companies || 0) < 1) {
    throw new Error("Packaged API mutation did not persist demo companies.");
  }
  const dataStatus = (await (
    await fetch(`${baseUrl}/api/data/status`)
  ).json()) as { data?: { dataDirectory?: string } };
  if (
    path.resolve(dataStatus.data?.dataDirectory || "") !== path.resolve(dataDir)
  ) {
    throw new Error("Packaged binary did not honor its isolated data directory.");
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
        `The embedded frontend did not return the app shell for ${route}.`,
      );
    }
  }
  await stopBinary(first);

  const restarted = startBinary(dataDir);
  await waitForHealth(restarted);
  const dashboardAfterRestart = (await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json()) as { data?: { companies?: number } };
  if (
    dashboardAfterRestart.data?.companies !==
    dashboardBeforeRestart.data?.companies
  ) {
    throw new Error("Packaged data did not survive a binary restart.");
  }
  await stopBinary(restarted);

  const defaultDirectory = expectedPackagedDataDir();
  const defaultPathRun = startBinary();
  await waitForHealth(defaultPathRun);
  const defaultDataStatus = (await (
    await fetch(`${baseUrl}/api/data/status`)
  ).json()) as { data?: { dataDirectory?: string } };
  if (
    path.resolve(defaultDataStatus.data?.dataDirectory || "") !==
    path.resolve(defaultDirectory)
  ) {
    throw new Error(
      `Packaged binary used an unexpected default data directory: ${defaultDataStatus.data?.dataDirectory || "(missing)"}.`,
    );
  }
  await stopBinary(defaultPathRun);
  if (!existsSync(path.join(defaultDirectory, "recruit-ai.sqlite"))) {
    throw new Error("Packaged binary did not initialize its default database.");
  }

  console.log(
    `Binary smoke passed from ${installDir}: ${health.data.runtime}; API security, mutation, ${appRoutes.length} direct routes, restart persistence, and the platform default data path verified.`,
  );
} catch (error) {
  if (activeChild) await stopBinary(activeChild);
  if (processOutput.length) console.error(processOutput.join("\n").trim());
  throw error;
} finally {
  if (activeChild) await stopBinary(activeChild);
  if (smokeRoot.startsWith(path.join(tmpdir(), "recruit-ai-binary-smoke-"))) {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}
