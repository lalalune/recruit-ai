import { readFileSync } from "node:fs";
import path from "node:path";
import { APP_VERSION } from "../src/shared/version";

interface PackageMetadata {
  engines?: { bun?: unknown };
  version?: unknown;
  packageManager?: unknown;
}

const projectRoot = path.resolve(import.meta.dir, "..");
const packageMetadata = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
) as PackageMetadata;
const pinnedBunVersion = readFileSync(
  path.join(projectRoot, ".bun-version"),
  "utf8",
).trim();
const failures: string[] = [];

if (typeof packageMetadata.version !== "string") {
  failures.push("package.json must contain a string version.");
} else if (packageMetadata.version !== APP_VERSION) {
  failures.push(
    `package.json version ${packageMetadata.version} does not match APP_VERSION ${APP_VERSION}.`,
  );
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(APP_VERSION)) {
  failures.push(`APP_VERSION is not a supported semantic version: ${APP_VERSION}`);
}

if (packageMetadata.packageManager !== `bun@${pinnedBunVersion}`) {
  failures.push(
    `packageManager must be bun@${pinnedBunVersion}, matching .bun-version.`,
  );
}

if (packageMetadata.engines?.bun !== pinnedBunVersion) {
  failures.push(
    `engines.bun must be ${pinnedBunVersion}, matching .bun-version.`,
  );
}

if (Bun.version !== pinnedBunVersion) {
  failures.push(
    `This checkout requires Bun ${pinnedBunVersion}; running ${Bun.version}.`,
  );
}

const releaseTag = process.env.RELEASE_TAG?.trim();
if (releaseTag && releaseTag !== `v${APP_VERSION}`) {
  failures.push(
    `Release tag ${releaseTag} does not match application version v${APP_VERSION}.`,
  );
}

if (failures.length > 0) {
  throw new Error(`Version check failed:\n- ${failures.join("\n- ")}`);
}

console.log(
  `Version check passed: RecruitAI ${APP_VERSION}, Bun ${pinnedBunVersion}${releaseTag ? `, tag ${releaseTag}` : ""}.`,
);
