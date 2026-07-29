import type {
  ApiResult,
  CompanyDetail,
  CompanyListItem,
  DashboardSummary,
  OutreachDraft,
  SourceRunItem,
} from "../../shared/types";

interface ListResponse<T> extends ApiResult<T[]> {
  meta: {
    total: number;
    limit: number;
    offset: number;
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-RecruitAI-Client": "1",
      ...(init.headers || {}),
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload && "error" in payload
        ? String(payload.error)
        : `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export const api = {
  dashboard: () =>
    request<ApiResult<DashboardSummary>>("/api/dashboard").then(
      (response) => response.data,
    ),
  companies: (params: URLSearchParams) =>
    request<ListResponse<CompanyListItem>>(`/api/companies?${params}`),
  company: (id: string) =>
    request<ApiResult<CompanyDetail>>(`/api/companies/${id}`).then(
      (response) => response.data,
    ),
  patchCompany: (id: string, body: Record<string, unknown>) =>
    request<ApiResult<CompanyDetail>>(`/api/companies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((response) => response.data),
  excludeCompany: (id: string, body: { reason: string; note?: string }) =>
    request<ApiResult<CompanyDetail>>(`/api/companies/${id}/exclude`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((response) => response.data),
  addManualJob: (id: string, body: Record<string, unknown>) =>
    request<ApiResult<CompanyDetail>>(`/api/companies/${id}/jobs/manual`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((response) => response.data),
  resolveConflict: (
    id: string,
    body: {
      resolution: "use_candidate" | "keep_current" | "research_further";
      note: string;
    },
  ) =>
    request<ApiResult<CompanyDetail>>(`/api/conflicts/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((response) => response.data),
  addContact: (companyId: string, body: Record<string, unknown>) =>
    request(`/api/companies/${companyId}/contacts`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchContact: (id: string, body: Record<string, unknown>) =>
    request(`/api/contacts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  review: (
    id: string,
    body: { decision: "approved" | "rejected" | "needs_research"; notes?: string },
  ) =>
    request<ApiResult<CompanyDetail>>(`/api/companies/${id}/review`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((response) => response.data),
  sourceRuns: () =>
    request<ApiResult<SourceRunItem[]>>("/api/source-runs").then(
      (response) => response.data,
    ),
  runDiscovery: (body: Record<string, unknown>) =>
    request<ApiResult<{ runId: string }>>("/api/discovery/run", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((response) => response.data),
  importCsv: (
    csv: string,
    sourceLabel: string,
    mapping?: Record<string, string>,
  ) =>
    request("/api/discovery/import", {
      method: "POST",
      body: JSON.stringify({ csv, sourceLabel, mapping }),
    }),
  loadDemo: () =>
    request("/api/discovery/demo", { method: "POST", body: "{}" }),
  researchWebsite: (companyId: string) =>
    request(`/api/companies/${companyId}/research/website`, {
      method: "POST",
      body: "{}",
    }),
  researchApollo: (companyId: string) =>
    request(`/api/companies/${companyId}/research/apollo`, {
      method: "POST",
      body: "{}",
    }),
  researchDomain: (companyId: string, autoApplyHighConfidence = false) =>
    request(`/api/companies/${companyId}/research/domain`, {
      method: "POST",
      body: JSON.stringify({ autoApplyHighConfidence }),
    }),
  verifyEmail: (
    contactId: string,
    provider: "hunter" | "zerobounce" = "hunter",
  ) =>
    request(
      `/api/contacts/${contactId}/verify?provider=${encodeURIComponent(provider)}`,
      {
      method: "POST",
      body: "{}",
      },
    ),
  findEmail: (companyId: string, contactId: string) =>
    request(`/api/companies/${companyId}/contacts/${contactId}/find-email`, {
      method: "POST",
      body: "{}",
    }),
  addEvidence: (body: Record<string, unknown>) =>
    request("/api/evidence/manual", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  drafts: (params = new URLSearchParams()) =>
    request<ListResponse<OutreachDraft>>(`/api/outreach/drafts?${params}`),
  generateDraft: (
    companyId: string,
    contactId: string,
    tone: "concise" | "technical" | "founder" = "concise",
  ) =>
    request<ApiResult<OutreachDraft>>(
      `/api/outreach/generate?companyId=${encodeURIComponent(companyId)}`,
      {
        method: "POST",
        body: JSON.stringify({ contactId, tone }),
      },
    ).then((response) => response.data),
  patchDraft: (id: string, body: Record<string, unknown>) =>
    request<ApiResult<OutreachDraft>>(`/api/outreach/drafts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((response) => response.data),
  settings: () => request<ApiResult<SettingsResponse>>("/api/settings").then((r) => r.data),
  patchSettings: (body: Record<string, unknown>) =>
    request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  patchSecrets: (body: Record<string, string | null>) =>
    request("/api/settings/secrets", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  testConnection: (
    provider: "apollo" | "hunter" | "zerobounce" | "socrata" | "brave",
  ) =>
    request<
      ApiResult<{ provider: string; ok: boolean; detail: string }>
    >("/api/settings/connections/test", {
      method: "POST",
      body: JSON.stringify({ provider }),
    }).then((response) => response.data),
  verificationProviders: () =>
    request<ApiResult<VerificationProvider[]>>("/api/verification/providers").then(
      (response) => response.data,
    ),
  gmailStatus: () =>
    request<ApiResult<GmailStatus>>("/api/gmail/status").then(
      (response) => response.data,
    ),
  gmailAuthUrl: () =>
    request<ApiResult<{ url: string }>>("/api/gmail/auth-url", {
      method: "POST",
      body: "{}",
    }).then((response) => response.data),
  gmailDisconnect: () =>
    request<ApiResult<GmailStatus>>("/api/gmail/disconnect", {
      method: "POST",
      body: "{}",
    }).then((response) => response.data),
  gmailTest: () =>
    request<
      ApiResult<{
        ok: boolean;
        messageId: string;
        sentTo: string;
        testedAt: string;
      }>
    >("/api/gmail/test", {
      method: "POST",
      body: "{}",
    }).then((response) => response.data),
  sendDraft: (draftId: string) =>
    request<ApiResult<OutreachDraft>>(`/api/outreach/drafts/${draftId}/send`, {
      method: "POST",
      body: "{}",
    }).then((response) => response.data),
  recordDraftOutcome: (
    draftId: string,
    outcome: "replied" | "bounced" | "no_response",
    note?: string,
  ) =>
    request<ApiResult<OutreachDraft>>(`/api/outreach/drafts/${draftId}/outcome`, {
      method: "POST",
      body: JSON.stringify({ outcome, note }),
    }).then((response) => response.data),
  sourcePolicies: () =>
    request<ApiResult<SourcePolicy[]>>("/api/source-policies").then(
      (response) => response.data,
    ),
  dataStatus: () =>
    request<ApiResult<LocalDataStatus>>("/api/data/status").then(
      (response) => response.data,
    ),
  createBackup: () =>
    request<ApiResult<BackupItem>>("/api/data/backup", {
      method: "POST",
      body: "{}",
    }).then((response) => response.data),
  inspectBackup: (backupText: string) =>
    request<ApiResult<BackupInspection>>("/api/data/backup/inspect", {
      method: "POST",
      body: JSON.stringify({ backupText }),
    }).then((response) => response.data),
  restoreBackup: (backupText: string, confirmation: string) =>
    request<
      ApiResult<{
        restoredAt: string;
        backupCreatedAt: string;
        snapshotCount: number;
        preRestoreBackup: string;
      }>
    >("/api/data/restore", {
      method: "POST",
      body: JSON.stringify({ backupText, confirmation }),
    }).then((response) => response.data),
  compactData: () =>
    request("/api/data/compact", { method: "POST", body: "{}" }),
  clearDemoData: (confirmation: string) =>
    request("/api/data/clear-demo", {
      method: "POST",
      body: JSON.stringify({ confirmation }),
    }),
  deleteAllData: (confirmation: string) =>
    request("/api/data/delete-all", {
      method: "POST",
      body: JSON.stringify({ confirmation }),
    }),
  openDataFolder: () =>
    request("/api/data/open-folder", { method: "POST", body: "{}" }),
};

export interface SettingsResponse {
  values: Record<string, unknown>;
  dataDirectory?: string;
  connections: Array<{
    key: string;
    configured: boolean;
    source: string | null;
  }>;
}

export interface VerificationProvider {
  id: "hunter" | "zerobounce";
  name: string;
  role: string;
  pricing: string;
}

export interface GmailStatus {
  configured: boolean;
  connected: boolean;
  accountEmail: string | null;
  sendingEnabled: boolean;
  testPassed: boolean;
  complianceReady: boolean;
  sendReady: boolean;
  missingRequirements: string[];
  limits: {
    hourlyCap: number;
    dailyCap: number;
    windowStart: number;
    windowEnd: number;
    verificationFreshnessDays: number;
    sendingDays: number[];
    timeZone: string;
  };
  usage: {
    sentLastHour: number;
    sentToday: number;
  };
}

export interface SourcePolicy {
  id: string;
  name: string;
  mode: "automatic" | "signal_only" | "manual";
  detail: string;
}

export interface BackupItem {
  fileName: string;
  createdAt: string;
  bytes: number;
  snapshotCount?: number;
  downloadUrl: string;
}

export interface BackupInspection {
  format: string;
  version: number;
  createdAt: string;
  appVersion: string;
  databaseBytes: number;
  snapshotCount: number;
}

export interface LocalDataStatus {
  dataDirectory: string;
  databasePath: string;
  databaseBytes: number;
  snapshotBytes: number;
  backupBytes: number;
  lastBackup: BackupItem | null;
  backups: BackupItem[];
  counts: {
    companies: number;
    contacts: number;
    jobs: number;
    evidence: number;
  };
  runtime: string;
  appVersion: string;
}
