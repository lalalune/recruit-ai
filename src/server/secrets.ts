import { getDatabase, nowIso } from "./database";

export type SecretKey =
  | "APOLLO_API_KEY"
  | "HUNTER_API_KEY"
  | "ZEROBOUNCE_API_KEY"
  | "SOCRATA_APP_TOKEN"
  | "BRAVE_SEARCH_API_KEY"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GOOGLE_REFRESH_TOKEN";

const knownKeys: SecretKey[] = [
  "APOLLO_API_KEY",
  "HUNTER_API_KEY",
  "ZEROBOUNCE_API_KEY",
  "SOCRATA_APP_TOKEN",
  "BRAVE_SEARCH_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
];

function readSavedSecrets(): Partial<Record<SecretKey, string>> {
  const rows = getDatabase()
    .query("SELECT key, value FROM secrets")
    .all() as Array<{ key: SecretKey; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function getSecret(key: SecretKey) {
  return process.env[key] || readSavedSecrets()[key] || null;
}

export function getConnectionSummary() {
  const saved = readSavedSecrets();
  return knownKeys
    .filter((key) => key !== "GOOGLE_REFRESH_TOKEN")
    .map((key) => ({
      key,
      configured: Boolean(process.env[key] || saved[key]),
      source: process.env[key]
        ? "environment"
        : saved[key]
          ? "local SQLite"
          : null,
    }));
}

export function saveSecrets(input: Partial<Record<SecretKey, string | null>>) {
  const database = getDatabase();
  database.transaction(() => {
    for (const key of knownKeys) {
      const value = input[key];
      if (value === undefined) continue;
      if (value === null || value.trim() === "") {
        database.query("DELETE FROM secrets WHERE key = ?").run(key);
      } else {
        database
          .query(
            `INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at`,
          )
          .run(key, value.trim(), nowIso());
      }
    }
  })();
  return getConnectionSummary();
}
