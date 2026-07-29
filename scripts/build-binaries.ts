import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { APP_VERSION } from "../src/shared/version";

type BuildMode = "current" | "all";
type Target = Bun.Build.CompileTarget;

interface BinaryTarget {
  target: Target;
  filename: string;
}

const projectRoot = path.resolve(import.meta.dir, "..");
const outputDir = path.join(projectRoot, "dist-bin");
const entrypoint = path.join(projectRoot, "src/server/index.ts");

const supportedTargets: BinaryTarget[] = [
  { target: "bun-darwin-arm64", filename: "recruit-ai-macos-arm64" },
  { target: "bun-darwin-x64", filename: "recruit-ai-macos-x64" },
  {
    target: "bun-windows-x64",
    filename: "recruit-ai-windows-x64.exe",
  },
  {
    target: "bun-linux-x64-baseline",
    filename: "recruit-ai-linux-x64",
  },
];

function currentTarget(): BinaryTarget {
  const match = supportedTargets.find((candidate) => {
    if (process.platform === "darwin") {
      return candidate.target === `bun-darwin-${process.arch}`;
    }
    if (process.platform === "win32" && process.arch === "x64") {
      return candidate.target === "bun-windows-x64";
    }
    if (process.platform === "linux" && process.arch === "x64") {
      return candidate.target === "bun-linux-x64-baseline";
    }
    return false;
  });
  if (match) return match;
  throw new Error(
    `No default binary target for ${process.platform}/${process.arch}. ` +
      "Use Bun on macOS arm64/x64, Windows x64, or Linux x64.",
  );
}

function currentCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.success
    ? result.stdout.toString().trim()
    : "unknown";
}

function sha256(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function compileBinary(binary: BinaryTarget, stagingDir: string) {
  const outfile = path.join(stagingDir, binary.filename);
  const useInstalledWindowsRuntime =
    process.platform === "win32" &&
    process.arch === "x64" &&
    binary.target === "bun-windows-x64";
  console.log(`Building ${binary.filename} (${binary.target})…`);
  const result = await Bun.build({
    entrypoints: [entrypoint],
    compile: {
      // Compiling the native Windows target with the installed runtime avoids
      // an unnecessary target-runtime download. Cross-compilation still pins
      // the documented standard Windows x64 target above.
      ...(useInstalledWindowsRuntime ? {} : { target: binary.target }),
      outfile,
      autoloadDotenv: true,
      autoloadBunfig: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
    },
    minify: true,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      RECRUITAI_PACKAGED: "true",
    },
  });
  if (!result.success) {
    const messages = result.logs.map((message) => {
      const position = message.position
        ? `${message.position.file}:${message.position.line}:${message.position.column}`
        : "build";
      return `${position}: ${message.message}`;
    });
    throw new Error(
      messages.join("\n") || `Bun could not build ${binary.filename}.`,
    );
  }
  const bytes = statSync(outfile).size;
  console.log(
    `Built ${binary.filename} (${(bytes / 1024 / 1024).toFixed(1)} MB)`,
  );
  return {
    filename: binary.filename,
    target: binary.target,
    bytes,
    sha256: sha256(outfile),
  };
}

const requestedMode = process.argv[2] ?? "current";
if (requestedMode !== "current" && requestedMode !== "all") {
  throw new Error("Usage: bun run scripts/build-binaries.ts [current|all]");
}

const mode = requestedMode as BuildMode;
const targets = mode === "all" ? supportedTargets : [currentTarget()];
const stagingDir = mkdtempSync(path.join(projectRoot, ".dist-bin-stage-"));
const previousDir = `${outputDir}.previous-${crypto.randomUUID()}`;

try {
  const artifacts = [];
  for (const target of targets) {
    artifacts.push(await compileBinary(target, stagingDir));
  }
  const manifest = {
    appVersion: APP_VERSION,
    commit: currentCommit(),
    bunVersion: Bun.version,
    mode,
    createdAt: new Date().toISOString(),
    artifacts,
  };
  writeFileSync(
    path.join(stagingDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stagingDir, "SHA256SUMS"),
    `${artifacts
      .map((artifact) => `${artifact.sha256}  ${artifact.filename}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );

  if (existsSync(outputDir)) renameSync(outputDir, previousDir);
  try {
    renameSync(stagingDir, outputDir);
  } catch (error) {
    if (existsSync(previousDir)) renameSync(previousDir, outputDir);
    throw error;
  }
  if (existsSync(previousDir)) {
    rmSync(previousDir, { recursive: true, force: true });
  }
  console.log(
    `Finished ${artifacts.length} standalone build${artifacts.length === 1 ? "" : "s"} with checksums.`,
  );
} catch (error) {
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  throw error;
}
