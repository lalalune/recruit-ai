import webApp from "../../index.html";
import { createApp } from "./app";
import { getDatabase } from "./database";
import { repairMissingCompanyStats } from "./repository";

const app = createApp();
getDatabase();
repairMissingCompanyStats();

const port = Number(process.env.RECRUITAI_PORT || 4317);
const development = process.env.RECRUITAI_DEV === "1";

const server = development
  ? Bun.serve({
      hostname: "127.0.0.1",
      port,
      development: true,
      routes: {
        "/api/*": (request) => app.fetch(request),
      },
      fetch: (request) => app.fetch(request),
    })
  : Bun.serve({
      hostname: "127.0.0.1",
      port,
      routes: {
        "/api/*": (request) => app.fetch(request),
        "/*": webApp,
      },
      fetch: (request) => app.fetch(request),
    });

const url = `http://${server.hostname}:${server.port}`;
console.log(`RecruitAI ${development ? "API" : "app"} running at ${url}`);

if (!development && process.env.RECRUITAI_NO_OPEN !== "1") {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {
    console.log("Open the URL above in your browser.");
  }
}
