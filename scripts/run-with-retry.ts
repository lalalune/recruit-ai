export {};

const attempts = Number(process.argv[2]);
const command = process.argv.slice(3);

if (
  !Number.isInteger(attempts) ||
  attempts < 1 ||
  attempts > 5 ||
  command.length === 0
) {
  throw new Error(
    "Usage: bun run scripts/run-with-retry.ts <attempts 1-5> <command> [args...]",
  );
}

let lastExitCode = 1;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  lastExitCode = await child.exited;
  if (lastExitCode === 0) process.exit(0);
  if (attempt < attempts) {
    const delayMilliseconds = attempt * 1_000;
    console.error(
      `Command failed with exit code ${lastExitCode} (attempt ${attempt}/${attempts}); retrying in ${delayMilliseconds / 1_000}s.`,
    );
    await Bun.sleep(delayMilliseconds);
  }
}

console.error(
  `Command failed after ${attempts} attempt${attempts === 1 ? "" : "s"}.`,
);
process.exit(lastExitCode);
