import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { APP_VERSION } from "../src/shared/version";

interface BuildArtifact {
  filename: string;
  target: string;
  bytes?: number;
  sha256?: string;
}

interface BuildManifest {
  appVersion?: string;
  commit?: string;
  bunVersion?: string;
  mode?: string;
  createdAt?: string;
  artifacts?: BuildArtifact[];
}

interface ReleaseTarget {
  archiveKind: "tar.gz" | "zip";
  archiveSlug: string;
  binaryFilename: string;
  packagedBinaryFilename: string;
  platformDescription: string;
  runCommand: string;
  dataPath: string;
}

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  repository?: unknown;
  homepage?: unknown;
}

interface ThirdPartyPackage {
  key: string;
  license: string;
  licenseText?: string;
  name: string;
  source?: string;
  version: string;
}

const projectRoot = path.resolve(import.meta.dir, "..");
const outputDir = path.join(projectRoot, "dist-bin");
const buildManifestPath = path.join(outputDir, "manifest.json");
const rootLicensePath = path.join(projectRoot, "LICENSE");
const packageMetadata = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
) as PackageMetadata & {
  dependencies?: Record<string, string>;
};

const releaseTargets: ReleaseTarget[] = [
  {
    archiveKind: "tar.gz",
    archiveSlug: "macos-arm64",
    binaryFilename: "recruit-ai-macos-arm64",
    packagedBinaryFilename: "recruit-ai",
    platformDescription: "macOS on Apple silicon (arm64)",
    runCommand: "./recruit-ai",
    dataPath: "~/Library/Application Support/RecruitAI",
  },
  {
    archiveKind: "tar.gz",
    archiveSlug: "macos-x64",
    binaryFilename: "recruit-ai-macos-x64",
    packagedBinaryFilename: "recruit-ai",
    platformDescription: "macOS on Intel (x64)",
    runCommand: "./recruit-ai",
    dataPath: "~/Library/Application Support/RecruitAI",
  },
  {
    archiveKind: "tar.gz",
    archiveSlug: "linux-x64",
    binaryFilename: "recruit-ai-linux-x64",
    packagedBinaryFilename: "recruit-ai",
    platformDescription: "x86-64 Linux with glibc",
    runCommand: "./recruit-ai",
    dataPath: "${XDG_DATA_HOME:-~/.local/share}/recruit-ai",
  },
  {
    archiveKind: "zip",
    archiveSlug: "windows-x64",
    binaryFilename: "recruit-ai-windows-x64.exe",
    packagedBinaryFilename: "recruit-ai.exe",
    platformDescription: "64-bit Windows (x64)",
    runCommand: ".\\recruit-ai.exe",
    dataPath:
      "%LOCALAPPDATA%\\RecruitAI (falling back to %APPDATA%\\RecruitAI)",
  },
];

function sha256(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sourceTreeIsDirty() {
  const result = Bun.spawnSync(
    ["git", "status", "--porcelain", "--untracked-files=normal"],
    {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (!result.success) {
    throw new Error(
      `Could not inspect the release source tree:\n${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim().length > 0;
}

function run(command: string, args: string[], cwd = projectRoot) {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    const details = [result.stdout.toString(), result.stderr.toString()]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${details ? `:\n${details}` : "."}`,
    );
  }
  return result.stdout.toString();
}

function repositoryUrl(repository: unknown, homepage: unknown) {
  if (typeof repository === "string") return repository;
  if (
    repository &&
    typeof repository === "object" &&
    "url" in repository &&
    typeof repository.url === "string"
  ) {
    return repository.url;
  }
  return typeof homepage === "string" ? homepage : undefined;
}

function declaredLicense(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const names = value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (
          entry &&
          typeof entry === "object" &&
          "type" in entry &&
          typeof entry.type === "string"
        ) {
          return entry.type;
        }
        return undefined;
      })
      .filter((entry): entry is string => Boolean(entry));
    if (names.length > 0) return names.join(" OR ");
  }
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string"
  ) {
    return value.type;
  }
  return "Not declared";
}

function licenseText(packageDirectory: string) {
  const candidate = readdirSync(packageDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .find((name) =>
      /^(?:licen[cs]e|copying|copyright|notice)(?:[._-].*)?$/i.test(name),
    );
  return candidate
    ? readFileSync(path.join(packageDirectory, candidate), "utf8").trim()
    : undefined;
}

async function collectThirdPartyPackages() {
  const nodeModules = path.join(projectRoot, "node_modules");
  if (!existsSync(nodeModules)) {
    throw new Error(
      "node_modules is missing. Run bun install --frozen-lockfile first.",
    );
  }

  const packages = new Map<string, ThirdPartyPackage>();
  const glob = new Bun.Glob("**/package.json");
  for await (const packageJsonPath of glob.scan({
    absolute: true,
    cwd: nodeModules,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    let metadata: PackageMetadata;
    try {
      metadata = JSON.parse(
        readFileSync(packageJsonPath, "utf8"),
      ) as PackageMetadata;
    } catch {
      continue;
    }
    if (
      typeof metadata.name !== "string" ||
      typeof metadata.version !== "string"
    ) {
      continue;
    }
    const key = `${metadata.name}@${metadata.version}`;
    const candidate: ThirdPartyPackage = {
      key,
      license: declaredLicense(metadata.license),
      licenseText: licenseText(path.dirname(packageJsonPath)),
      name: metadata.name,
      source: repositoryUrl(metadata.repository, metadata.homepage),
      version: metadata.version,
    };
    const existing = packages.get(key);
    if (!existing || (!existing.licenseText && candidate.licenseText)) {
      packages.set(key, candidate);
    }
  }

  for (const dependency of Object.keys(packageMetadata.dependencies || {})) {
    if (![...packages.values()].some((entry) => entry.name === dependency)) {
      throw new Error(
        `Could not locate license metadata for runtime dependency ${dependency}.`,
      );
    }
  }

  return [...packages.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

function renderThirdPartyNotices(packages: ThirdPartyPackage[]) {
  const bunTag = `bun-v${Bun.version}`;
  const introduction = `RecruitAI third-party notices

This file is generated from the packages installed by the locked release build.
It intentionally includes build and test dependencies as a conservative
superset of the JavaScript packages contained in the executable or web bundle.

The standalone executable also contains the Bun ${Bun.version} runtime. Bun is
MIT-licensed and statically links additional components, including
JavaScriptCore/WebKit under LGPL terms. Bun's complete runtime license,
relinking information, and linked-library notices for this exact tag are at:
https://github.com/oven-sh/bun/blob/${bunTag}/LICENSE.md

RecruitAI's own license is provided separately as LICENSE.
`;

  const sections = packages.map((entry) => {
    const source = entry.source ? `\nSource: ${entry.source}` : "";
    const text = entry.licenseText
      ? `\n\n${entry.licenseText}`
      : "\n\nNo license file was present in the installed package; consult the source above and the declared SPDX expression.";
    return `================================================================================
${entry.key}
Declared license: ${entry.license}${source}${text}`;
  });

  return `${introduction}\n${sections.join("\n\n")}\n`;
}

function renderReleaseReadme(target: ReleaseTarget, sourceDirty: boolean) {
  return `RecruitAI ${APP_VERSION}
====================

Platform: ${target.platformDescription}
Run: ${target.runCommand}
Source state: ${
    sourceDirty
      ? "DIRTY local checkout; this artifact is not eligible for publication"
      : "clean checkout at the commit recorded in manifest.json"
  }

RecruitAI starts a loopback-only local service and opens the interface in the
system browser. The default data location for this platform is:

  ${target.dataPath}

RECRUITAI_DATA_DIR can override that location. The database, snapshots,
credentials, backups, exports, and outreach history are sensitive local data.

This build has no trusted Developer ID or Authenticode signature and, on macOS,
is not notarized. A macOS executable may still carry an ad hoc linker signature;
that does not establish publisher identity. Do not publish or redistribute it
as a trusted desktop release until the platform signing work is complete.
Operating-system security prompts are expected; review the source and release
checksum instead of disabling platform security.

Verify the downloaded archive against SHA256SUMS from the same GitHub release
before extracting it. LICENSE covers RecruitAI. THIRD_PARTY_NOTICES.txt records
the bundled runtime and package licenses.
`;
}

function validateArchive(
  archivePath: string,
  bundleName: string,
  kind: ReleaseTarget["archiveKind"],
  packagedBinaryFilename: string,
) {
  const listing =
    kind === "tar.gz"
      ? run("tar", ["-tzf", archivePath])
      : run("unzip", ["-Z1", archivePath]);
  const entries = listing
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    if (
      entry.startsWith("/") ||
      entry.split("/").some((segment) => segment === "..")
    ) {
      throw new Error(`Unsafe path in ${path.basename(archivePath)}: ${entry}`);
    }
  }
  for (const required of [
    `${bundleName}/${packagedBinaryFilename}`,
    `${bundleName}/LICENSE`,
    `${bundleName}/README.txt`,
    `${bundleName}/THIRD_PARTY_NOTICES.txt`,
  ]) {
    if (!entries.includes(required)) {
      throw new Error(
        `${path.basename(archivePath)} is missing required entry ${required}.`,
      );
    }
  }
}

if (!existsSync(buildManifestPath)) {
  throw new Error(
    "dist-bin/manifest.json is missing. Run bun run build:binaries first.",
  );
}
if (!existsSync(rootLicensePath)) {
  throw new Error("The root LICENSE file is required for release packaging.");
}
if (
  packageMetadata.version !== APP_VERSION ||
  typeof packageMetadata.version !== "string"
) {
  throw new Error(
    `package.json version ${String(packageMetadata.version)} does not match APP_VERSION ${APP_VERSION}.`,
  );
}

const buildManifest = JSON.parse(
  readFileSync(buildManifestPath, "utf8"),
) as BuildManifest;
if (buildManifest.appVersion !== APP_VERSION) {
  throw new Error(
    `Binary manifest version ${String(buildManifest.appVersion)} does not match ${APP_VERSION}.`,
  );
}
if (buildManifest.mode !== "all") {
  throw new Error(
    "Release packaging requires an all-target binary manifest. Run bun run build:binaries.",
  );
}

const buildArtifacts = new Map(
  (buildManifest.artifacts || []).map((artifact) => [
    artifact.filename,
    artifact,
  ]),
);
for (const target of releaseTargets) {
  const artifact = buildArtifacts.get(target.binaryFilename);
  const binaryPath = path.join(outputDir, target.binaryFilename);
  if (!artifact || !existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
    throw new Error(`Missing release binary ${target.binaryFilename}.`);
  }
}

const thirdPartyPackages = await collectThirdPartyPackages();
const thirdPartyNotices = renderThirdPartyNotices(thirdPartyPackages);
const sourceDirty = sourceTreeIsDirty();
if (process.env.CI && sourceDirty) {
  throw new Error("Refusing to package a dirty source tree in CI.");
}
const stagingRoot = mkdtempSync(path.join(outputDir, ".release-package-stage-"));

try {
  const releaseArtifacts = [];
  for (const target of releaseTargets) {
    const bundleName = `recruit-ai-v${APP_VERSION}-${target.archiveSlug}`;
    const bundleDirectory = path.join(stagingRoot, bundleName);
    const sourceBinaryPath = path.join(outputDir, target.binaryFilename);
    const packagedBinaryPath = path.join(
      bundleDirectory,
      target.packagedBinaryFilename,
    );
    mkdirSync(bundleDirectory, { recursive: true, mode: 0o755 });
    copyFileSync(sourceBinaryPath, packagedBinaryPath);
    if (target.archiveKind === "tar.gz") {
      chmodSync(packagedBinaryPath, 0o755);
    }
    copyFileSync(rootLicensePath, path.join(bundleDirectory, "LICENSE"));
    writeFileSync(
      path.join(bundleDirectory, "README.txt"),
      renderReleaseReadme(target, sourceDirty),
      { mode: 0o644 },
    );
    writeFileSync(
      path.join(bundleDirectory, "THIRD_PARTY_NOTICES.txt"),
      thirdPartyNotices,
      { mode: 0o644 },
    );

    const archiveFilename = `${bundleName}.${target.archiveKind}`;
    const archivePath = path.join(stagingRoot, archiveFilename);
    if (target.archiveKind === "tar.gz") {
      run("tar", ["-czf", archivePath, "-C", stagingRoot, bundleName]);
    } else {
      run("zip", ["-q", "-r", archivePath, bundleName], stagingRoot);
    }
    validateArchive(
      archivePath,
      bundleName,
      target.archiveKind,
      target.packagedBinaryFilename,
    );

    const buildArtifact = buildArtifacts.get(target.binaryFilename)!;
    releaseArtifacts.push({
      filename: target.binaryFilename,
      target: buildArtifact.target,
      bytes: statSync(sourceBinaryPath).size,
      sha256: sha256(sourceBinaryPath),
      archive: {
        filename: archiveFilename,
        bytes: statSync(archivePath).size,
        sha256: sha256(archivePath),
      },
    });
  }

  const releaseManifest = {
    formatVersion: 1,
    appVersion: APP_VERSION,
    commit: buildManifest.commit || process.env.GITHUB_SHA || "unknown",
    bunVersion: buildManifest.bunVersion || Bun.version,
    mode: "release",
    createdAt: buildManifest.createdAt,
    packagedAt: new Date().toISOString(),
    sourceDirty,
    unsigned: true,
    artifacts: releaseArtifacts,
  };
  const stagedManifestPath = path.join(stagingRoot, "manifest.json");
  writeFileSync(
    stagedManifestPath,
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  const checksumEntries = [
    ...releaseArtifacts.map((artifact) => ({
      filename: artifact.archive.filename,
      sha256: artifact.archive.sha256,
    })),
    {
      filename: "manifest.json",
      sha256: sha256(stagedManifestPath),
    },
  ];
  const stagedChecksumsPath = path.join(stagingRoot, "SHA256SUMS");
  writeFileSync(
    stagedChecksumsPath,
    `${checksumEntries
      .map((entry) => `${entry.sha256}  ${entry.filename}`)
      .join("\n")}\n`,
    { mode: 0o644 },
  );

  for (const filename of [
    ...checksumEntries.map((entry) => entry.filename),
    "SHA256SUMS",
  ]) {
    const stagedPath = path.join(stagingRoot, filename);
    const destinationPath = path.join(outputDir, filename);
    if (existsSync(destinationPath)) rmSync(destinationPath, { force: true });
    renameSync(stagedPath, destinationPath);
  }

  console.log(
    `Packaged ${releaseArtifacts.length} unsigned release archives for RecruitAI ${APP_VERSION}; SHA256SUMS covers every archive and manifest.json.`,
  );
} finally {
  if (
    stagingRoot.startsWith(path.join(outputDir, ".release-package-stage-"))
  ) {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}
