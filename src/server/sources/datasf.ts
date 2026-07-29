import { addEvidence, upsertCompany } from "../repository";
import { getSecret } from "../secrets";
import { fetchWithTimeout } from "./http";

interface DataSfRow {
  dba_name?: string;
  ownership_name?: string;
  full_business_address?: string;
  business_address?: string;
  city?: string;
  state?: string;
  business_zip?: string;
  naics_code?: string;
  location_start_date?: string;
  location_end_date?: string;
  certificate_number?: string;
  uniqueid?: string;
}

const technologyPrefixes = [
  "334",
  "335",
  "3364",
  "3391",
  "5112",
  "5121",
  "517",
  "518",
  "519",
  "5413",
  "5415",
  "5417",
  "5419",
  "6215",
];

export async function discoverDataSf(
  limit: number,
  technologyOnly: boolean,
) {
  const pageSize = Math.min(1000, limit);
  const token = getSecret("SOCRATA_APP_TOKEN");
  let offset = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set<string>();

  while (inserted + updated < limit) {
    const query = new URLSearchParams({
      $limit: String(pageSize),
      $offset: String(offset),
      $order: "location_start_date DESC",
    });
    const response = await fetchWithTimeout(
      `https://data.sfgov.org/resource/g8m3-pdis.json?${query}`,
      token ? { headers: { "X-App-Token": token } } : {},
      30_000,
    );
    const rows = (await response.json()) as DataSfRow[];
    if (!rows.length) break;

    for (const row of rows) {
      if (inserted + updated >= limit) break;
      if (row.location_end_date && new Date(row.location_end_date) < new Date()) {
        skipped++;
        continue;
      }
      if (
        technologyOnly &&
        (!row.naics_code ||
          !technologyPrefixes.some((prefix) => row.naics_code?.startsWith(prefix)))
      ) {
        skipped++;
        continue;
      }
      const name = (row.dba_name || row.ownership_name || "").trim();
      if (!name) {
        skipped++;
        continue;
      }
      const dedupeKey = `${name.toLowerCase()}:${row.business_zip || ""}`;
      if (seen.has(dedupeKey)) {
        skipped++;
        continue;
      }
      seen.add(dedupeKey);
      const location =
        row.full_business_address ||
        row.business_address ||
        [row.city, row.state, row.business_zip].filter(Boolean).join(", ") ||
        "San Francisco, CA";
      const company = upsertCompany({
        name,
        location,
        industries: row.naics_code ? [`NAICS ${row.naics_code}`] : [],
        status: "needs_research",
      });
      if (company.inserted) inserted++;
      else updated++;
      addEvidence({
        entityType: "company",
        entityId: company.id,
        fieldName: "registered_business",
        value: row.certificate_number || row.uniqueid || name,
        sourceType: "datasf",
        sourceLabel: "DataSF registered business",
        sourceUrl:
          "https://data.sfgov.org/Economy-and-Community/Registered-Business-Locations-San-Francisco/g8m3-pdis/about_data",
        excerpt: `${name} — ${location}`,
        confidence: 0.7,
        payload: row,
      });
    }
    offset += rows.length;
    if (rows.length < pageSize) break;
  }
  return { inserted, updated, skipped };
}
