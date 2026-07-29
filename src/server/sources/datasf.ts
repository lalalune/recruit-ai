import { addEvidence, upsertCompany } from "../repository";
import { getSecret } from "../secrets";
import { z } from "zod";
import { badRequest, upstreamFailure } from "../errors";
import { fetchProviderResponse, readBoundedJson } from "./http";

const DataSfName = z.string().max(500);
const DataSfAddress = z.string().max(500);
const DataSfRowSchema = z.object({
  dba_name: DataSfName.optional(),
  ownership_name: DataSfName.optional(),
  full_business_address: DataSfAddress.optional(),
  business_address: DataSfAddress.optional(),
  city: z.string().max(200).optional(),
  state: z.string().max(200).optional(),
  business_zip: z.string().max(100).optional(),
  naics_code: z.string().max(100).optional(),
  location_start_date: z.string().max(100).optional(),
  location_end_date: z.string().max(100).optional(),
  certificate_number: z.string().max(500).optional(),
  uniqueid: z.string().max(500).optional(),
});
const DataSfRowsSchema = z.array(DataSfRowSchema).max(1_000);
const MAX_DATASF_PAGES = 50;
const MAX_DATASF_ROWS_SCANNED = 50_000;
const DATASF_SCAN_MULTIPLIER = 5;

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
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw badRequest("DataSF discovery limit must be an integer from 1 to 10,000.");
  }
  const pageSize = Math.min(1_000, limit);
  const rowScanBudget = Math.min(
    MAX_DATASF_ROWS_SCANNED,
    Math.max(pageSize, limit * DATASF_SCAN_MULTIPLIER),
  );
  const token = getSecret("SOCRATA_APP_TOKEN");
  let offset = 0;
  let pagesScanned = 0;
  let rowsScanned = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set<string>();

  while (
    inserted + updated < limit &&
    pagesScanned < MAX_DATASF_PAGES &&
    rowsScanned < rowScanBudget
  ) {
    const requestedPageSize = Math.min(
      pageSize,
      rowScanBudget - rowsScanned,
    );
    const query = new URLSearchParams({
      $limit: String(requestedPageSize),
      $offset: String(offset),
      $order: "location_start_date DESC",
    });
    const response = await fetchProviderResponse(
      "DataSF",
      `https://data.sfgov.org/resource/g8m3-pdis.json?${query}`,
      token ? { headers: { "X-App-Token": token } } : {},
      30_000,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw upstreamFailure(
        `DataSF rejected the request (HTTP ${response.status}).`,
        "datasf_request_rejected",
      );
    }
    const rows = await readBoundedJson(
      response,
      "DataSF",
      DataSfRowsSchema,
      5_000_000,
    );
    pagesScanned++;
    if (rows.length > requestedPageSize) {
      throw upstreamFailure(
        "DataSF returned more rows than requested.",
        "datasf_payload_invalid",
      );
    }
    if (!rows.length) break;
    rowsScanned += rows.length;

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
    if (rows.length < requestedPageSize) break;
  }
  return { inserted, updated, skipped };
}
