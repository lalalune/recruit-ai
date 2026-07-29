import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const apiPort = Number(environment.RECRUITAI_PORT || 4317);
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65_535) {
    throw new Error("RECRUITAI_PORT must be an integer from 1 through 65535.");
  }
  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`,
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
