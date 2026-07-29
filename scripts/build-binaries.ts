import { mkdirSync, statSync } from "node:fs";
import path from "node:path";

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
  {
    target: "bun-darwin-arm64",
    filename: "recruit-ai-macos-arm64",
  },
  {
    target: "bun-darwin-x64",
    filename: "recruit-ai-macos-x64",
  },
  {
    target: "bun-windows-x64-baseline",
    filename: "recruit-ai-windows-x64.exe",
  },
  {
    target: "bun-linux-x64-baseline",
    filename: "recruit-ai-linux-x64",
  },
];

function currentTarget(): BinaryTarget {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return supportedTargets[0];
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return supportedTargets[1];
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return supportedTargets[2];
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return supportedTargets[3];
  }
  throw new Error(
    `No default binary target for ${process.platform}/${process.arch}. ` +
      "Use Bun on macOS arm64/x64, Windows x64, or Linux x64.",
  );
}

async function compileBinary(binary: BinaryTarget) {
  const outfile = path.join(outputDir, binary.filename);
  console.log(`Building ${binary.filename} (${binary.target})…`);

  const result = await Bun.build({
    entrypoints: [entrypoint],
    compile: {
      target: binary.target,
      outfile,
      autoloadDotenv: true,
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

  const size = ` (${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MB)`;
  console.log(`Built ${path.relative(projectRoot, outfile)}${size}`);
}

const requestedMode = process.argv[2] ?? "current";
if (requestedMode !== "current" && requestedMode !== "all") {
  throw new Error("Usage: bun run scripts/build-binaries.ts [current|all]");
}

const mode = requestedMode as BuildMode;
const targets = mode === "all" ? supportedTargets : [currentTarget()];
mkdirSync(outputDir, { recursive: true });

for (const target of targets) {
  await compileBinary(target);
}

console.log(`Finished ${targets.length} standalone build${targets.length === 1 ? "" : "s"}.`);
