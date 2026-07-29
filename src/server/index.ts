import webApp from "../../index.html";
import { createApp } from "./app";
import { recoverInterruptedRestore } from "./dataManagement";
import { getDatabase } from "./database";
import { acquireInstanceLock } from "./instanceLock";
import { repairMissingCompanyStats } from "./repository";

acquireInstanceLock();
recoverInterruptedRestore();
const app = createApp();
getDatabase();
repairMissingCompanyStats();

const port = Number(process.env.RECRUITAI_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("RECRUITAI_PORT must be an integer from 1 through 65535.");
}
const development = process.env.RECRUITAI_DEV === "1";
function apiHandler(request: Request, server: Bun.Server<undefined>) {
  server.timeout(request, 0);
  return app.fetch(request);
}

const server = development
  ? Bun.serve({
      hostname: "127.0.0.1",
      port,
      maxRequestBodySize: 600 * 1024 * 1024,
      development: true,
      routes: {
        "/api/*": apiHandler,
      },
      fetch: apiHandler,
    })
  : Bun.serve({
      hostname: "127.0.0.1",
      port,
      maxRequestBodySize: 600 * 1024 * 1024,
      routes: {
        "/api/*": apiHandler,
        "/*": webApp,
      },
      fetch: apiHandler,
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
