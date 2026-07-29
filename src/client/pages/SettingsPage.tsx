import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  Check,
  Database,
  ExternalLink,
  FileLock2,
  FolderOpen,
  Gauge,
  HardDrive,
  KeyRound,
  Link2,
  LockKeyhole,
  Mail,
  MapPin,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Unplug,
  Upload,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "../lib/router";
import { PageHeader } from "../components/PageHeader";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  InlineNotice,
  Input,
  Spinner,
  Textarea,
} from "../components/ui";
import {
  api,
  type BackupInspection,
  type SettingsResponse,
} from "../lib/api";

interface AppSettings {
  scopeLocation: string;
  employeeMin: string;
  employeeMax: string;
  industries: string;
  jobFreshnessDays: string;
  jobRefreshDays: string;
  maxEvidenceAgeDays: string;
  companySitePageLimit: string;
  technologyOnlyDataSf: boolean;
  autoPrioritizeHiring: boolean;
  emailFreshnessDays: string;
  catchAllPolicy: string;
  secondVerifier: string;
  excludeSocialJustice: boolean;
  hourlyCap: string;
  dailyCap: string;
  sendWindowStart: string;
  sendWindowEnd: string;
  sendDays: number[];
  timeZone: string;
  noResponseWaitDays: string;
  bouncePauseEnabled: boolean;
  bounceThreshold: string;
  senderName: string;
  organizationName: string;
  postalAddress: string;
  optOutText: string;
  replyHandlingNote: string;
  complianceConfirmed: boolean;
  sendingEnabled: boolean;
}

const defaults: AppSettings = {
  scopeLocation: "San Francisco Bay Area",
  employeeMin: "3",
  employeeMax: "1000",
  industries: "AI, ML, data, robotics, hardware, manufacturing, research",
  jobFreshnessDays: "180",
  jobRefreshDays: "90",
  maxEvidenceAgeDays: "180",
  companySitePageLimit: "12",
  technologyOnlyDataSf: true,
  autoPrioritizeHiring: true,
  emailFreshnessDays: "30",
  catchAllPolicy: "review",
  secondVerifier: "none",
  excludeSocialJustice: true,
  hourlyCap: "20",
  dailyCap: "200",
  sendWindowStart: "8",
  sendWindowEnd: "20",
  sendDays: [1, 2, 3, 4, 5],
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles",
  noResponseWaitDays: "7",
  bouncePauseEnabled: true,
  bounceThreshold: "3",
  senderName: "",
  organizationName: "",
  postalAddress: "",
  optOutText: "If this is not relevant, reply and I will not contact you again.",
  replyHandlingNote: "",
  complianceConfirmed: false,
  sendingEnabled: false,
};

const providers = [
  {
    key: "APOLLO_API_KEY",
    label: "Apollo",
    purpose: "Company and decision-maker enrichment",
    href: "https://developer.apollo.io/",
    testId: "apollo",
    group: "research",
  },
  {
    key: "HUNTER_API_KEY",
    label: "Hunter",
    purpose: "Work email finder and primary verification",
    href: "https://hunter.io/api-documentation",
    testId: "hunter",
    group: "research",
  },
  {
    key: "ZEROBOUNCE_API_KEY",
    label: "ZeroBounce",
    purpose: "Optional second email verifier",
    href: "https://www.zerobounce.net/docs/email-validation-api-quickstart/",
    testId: "zerobounce",
    group: "research",
  },
  {
    key: "SOCRATA_APP_TOKEN",
    label: "DataSF app token",
    purpose: "Higher public-data API limits",
    href: "https://dev.socrata.com/",
    testId: "socrata",
    group: "research",
  },
  {
    key: "BRAVE_SEARCH_API_KEY",
    label: "Brave Search",
    purpose: "Optional domain and public-page discovery",
    href: "https://brave.com/search/api/",
    testId: "brave",
    group: "research",
  },
] as const;

const weekdays = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
] as const;

function fromResponse(response?: SettingsResponse): AppSettings {
  if (!response) return defaults;
  const values = response.values;
  const read = (key: string, fallback: string) =>
    values[key] === undefined || values[key] === null
      ? fallback
      : String(values[key]);
  return {
    scopeLocation: read("scopeLocation", defaults.scopeLocation),
    employeeMin: read("employeeMin", defaults.employeeMin),
    employeeMax: read("employeeMax", defaults.employeeMax),
    industries: Array.isArray(values.industries)
      ? values.industries.join(", ")
      : defaults.industries,
    jobFreshnessDays: read("jobFreshnessDays", defaults.jobFreshnessDays),
    jobRefreshDays: read("jobRefreshDays", defaults.jobRefreshDays),
    maxEvidenceAgeDays: read(
      "maxEvidenceAgeDays",
      defaults.maxEvidenceAgeDays,
    ),
    companySitePageLimit: read(
      "companySitePageLimit",
      defaults.companySitePageLimit,
    ),
    technologyOnlyDataSf:
      values.technologyOnlyDataSf === undefined
        ? defaults.technologyOnlyDataSf
        : Boolean(values.technologyOnlyDataSf),
    autoPrioritizeHiring:
      values.autoPrioritizeHiring === undefined
        ? defaults.autoPrioritizeHiring
        : Boolean(values.autoPrioritizeHiring),
    emailFreshnessDays: read("emailFreshnessDays", defaults.emailFreshnessDays),
    catchAllPolicy: read("catchAllPolicy", defaults.catchAllPolicy),
    secondVerifier: read("secondVerifier", defaults.secondVerifier),
    excludeSocialJustice:
      values.excludeSocialJustice === undefined
        ? defaults.excludeSocialJustice
        : Boolean(values.excludeSocialJustice),
    hourlyCap: read("gmail_hourly_cap", defaults.hourlyCap),
    dailyCap: read("gmail_daily_cap", defaults.dailyCap),
    sendWindowStart: read("sending_window_start", defaults.sendWindowStart),
    sendWindowEnd: read("sending_window_end", defaults.sendWindowEnd),
    sendDays: Array.isArray(values.sending_days)
      ? (values.sending_days as number[])
      : defaults.sendDays,
    timeZone: read("time_zone", defaults.timeZone),
    noResponseWaitDays: read(
      "no_response_wait_days",
      defaults.noResponseWaitDays,
    ),
    bouncePauseEnabled:
      values.bounce_pause_enabled === undefined
        ? defaults.bouncePauseEnabled
        : Boolean(values.bounce_pause_enabled),
    bounceThreshold: read("bounce_threshold", defaults.bounceThreshold),
    senderName: read("sender_name", defaults.senderName),
    organizationName: read("organization_name", defaults.organizationName),
    postalAddress: read("postal_address", defaults.postalAddress),
    optOutText: read("opt_out_text", defaults.optOutText),
    replyHandlingNote: read(
      "reply_handling_note",
      defaults.replyHandlingNote,
    ),
    complianceConfirmed: Boolean(values.compliance_confirmed),
    sendingEnabled: Boolean(values.gmail_sending_enabled),
  };
}

function SettingSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Database;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section__heading">
        <span>
          <Icon size={18} />
        </span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

function ProviderDialog({
  provider,
  configured,
  source,
}: {
  provider: (typeof providers)[number];
  configured: boolean;
  source: string | null;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const mutation = useMutation({
    mutationFn: (nextValue: string | null) =>
      api.patchSecrets({ [provider.key]: nextValue }),
    onSuccess: async () => {
      setValue("");
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      setOpen(false);
    },
  });
  function handleOpenChange(nextOpen: boolean) {
    setValue("");
    mutation.reset();
    setOpen(nextOpen);
  }

  return (
    <Dialog
      description="The value is never shown again. Environment variables override locally saved keys."
      onOpenChange={handleOpenChange}
      open={open}
      title={`Configure ${provider.label}`}
      trigger={<Button>{configured ? "Replace key" : "Add key"}</Button>}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate(value);
        }}
      >
        {source === "environment" ? (
          <InlineNotice tone="warning">
            This key comes from the environment. A locally saved value will not override it.
          </InlineNotice>
        ) : null}
        <label className="field">
          <span>API key</span>
          <Input
            autoComplete="off"
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste key"
            type="password"
            value={value}
          />
        </label>
        {mutation.error ? (
          <InlineNotice tone="danger">{mutation.error.message}</InlineNotice>
        ) : null}
        <div className="dialog-actions dialog-actions--spread">
          <div>
            {configured && source !== "environment" ? (
              <Button
                disabled={mutation.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove the locally saved ${provider.label} credential? Existing research data will remain.`,
                    )
                  ) {
                    mutation.mutate(null);
                  }
                }}
                variant="danger"
              >
                <Trash2 size={15} />
                Remove local key
              </Button>
            ) : null}
          </div>
          <div className="button-group">
            <Button onClick={() => handleOpenChange(false)}>Cancel</Button>
            <Button
              disabled={!value.trim() || mutation.isPending}
              type="submit"
              variant="primary"
            >
              Save key
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function ProviderTestButton({
  provider,
  configured,
}: {
  provider: (typeof providers)[number];
  configured: boolean;
}) {
  const mutation = useMutation({
    mutationFn: () => api.testConnection(provider.testId),
  });
  return (
    <div className="connection-test">
      <Button
        disabled={!configured || mutation.isPending}
        onClick={() => mutation.mutate()}
        variant="ghost"
      >
        {mutation.isPending ? "Testing…" : "Test"}
      </Button>
      {mutation.data ? (
        <small className="connection-test__success">{mutation.data.detail}</small>
      ) : null}
      {mutation.error ? (
        <small className="connection-test__error">{mutation.error.message}</small>
      ) : null}
    </div>
  );
}

function GoogleCredentialsDialog({
  clientConfigured,
  secretConfigured,
}: {
  clientConfigured: boolean;
  secretConfigured: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api.patchSecrets({
        ...(clientId ? { GOOGLE_CLIENT_ID: clientId } : {}),
        ...(clientSecret ? { GOOGLE_CLIENT_SECRET: clientSecret } : {}),
      }),
    onSuccess: async () => {
      setClientId("");
      setClientSecret("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["gmail-status"] }),
      ]);
      setOpen(false);
    },
  });
  function handleOpenChange(nextOpen: boolean) {
    setClientId("");
    setClientSecret("");
    mutation.reset();
    setOpen(nextOpen);
  }

  return (
    <Dialog
      description="Create a Desktop app OAuth client in Google Cloud, then save both values locally."
      onOpenChange={handleOpenChange}
      open={open}
      title="Google OAuth credentials"
      trigger={
        <Button>
          <KeyRound size={15} />
          {clientConfigured && secretConfigured ? "Replace credentials" : "Add credentials"}
        </Button>
      }
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <InlineNotice tone="info">
          Use your own Google Cloud project. RecruitAI does not upload these credentials or
          store browser cookies.
        </InlineNotice>
        <label className="field">
          <span>OAuth client ID</span>
          <Input
            autoComplete="off"
            onChange={(event) => setClientId(event.target.value)}
            placeholder={clientConfigured ? "Configured — paste to replace" : "…apps.googleusercontent.com"}
            value={clientId}
          />
        </label>
        <label className="field">
          <span>OAuth client secret</span>
          <Input
            autoComplete="off"
            onChange={(event) => setClientSecret(event.target.value)}
            placeholder={secretConfigured ? "Configured — paste to replace" : "Paste secret"}
            type="password"
            value={clientSecret}
          />
        </label>
        {mutation.error ? (
          <InlineNotice tone="danger">{mutation.error.message}</InlineNotice>
        ) : null}
        <div className="dialog-actions">
          <Button onClick={() => handleOpenChange(false)}>Cancel</Button>
          <Button
            disabled={mutation.isPending || (!clientId && !clientSecret)}
            type="submit"
            variant="primary"
          >
            Save credentials
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = units[0];
  for (let index = 1; value >= 1_024 && index < units.length; index++) {
    value /= 1_024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatDataDate(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function TypedConfirmationDialog({
  action,
  confirmLabel,
  description,
  disabled = false,
  phrase,
  title,
  triggerIcon,
  triggerLabel,
  triggerVariant = "danger",
}: {
  action: () => Promise<unknown>;
  confirmLabel: string;
  description: string;
  disabled?: boolean;
  phrase: string;
  title: string;
  triggerIcon: React.ReactNode;
  triggerLabel: string;
  triggerVariant?: "secondary" | "ghost" | "danger";
}) {
  const confirmationId = useId();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const mutation = useMutation({
    mutationFn: action,
    onSuccess: () => {
      setOpen(false);
      setConfirmation("");
    },
  });

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setConfirmation("");
      mutation.reset();
    }
  }

  return (
    <Dialog
      description={description}
      onOpenChange={handleOpenChange}
      open={open}
      title={title}
      trigger={
        <Button disabled={disabled} variant={triggerVariant}>
          {triggerIcon}
          {triggerLabel}
        </Button>
      }
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <label className="field" htmlFor={confirmationId}>
          <span>
            Type <code className="confirmation-phrase">{phrase}</code> to confirm
          </span>
          <Input
            autoComplete="off"
            autoFocus
            id={confirmationId}
            onChange={(event) => setConfirmation(event.target.value)}
            spellCheck={false}
            value={confirmation}
          />
        </label>
        {mutation.error ? (
          <InlineNotice tone="danger">{mutation.error.message}</InlineNotice>
        ) : null}
        <div className="dialog-actions">
          <Button onClick={() => handleOpenChange(false)}>Cancel</Button>
          <Button
            disabled={confirmation !== phrase || mutation.isPending}
            type="submit"
            variant="danger"
          >
            {mutation.isPending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const gmail = useQuery({ queryKey: ["gmail-status"], queryFn: api.gmailStatus });
  const dataStatus = useQuery({
    queryKey: ["data-status"],
    queryFn: api.dataStatus,
  });
  const [form, setForm] = useState<AppSettings>(defaults);
  const formHydrated = useRef(false);
  const dirtyFields = useRef(new Set<keyof AppSettings>());
  const [savedSection, setSavedSection] = useState<string | null>(null);
  const [dataMessage, setDataMessage] = useState<string | null>(null);
  const restoreFileInput = useRef<HTMLInputElement>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [restoreCandidate, setRestoreCandidate] = useState<{
    fileName: string;
    backupText: string;
    inspection: BackupInspection;
  } | null>(null);

  const invalidateWorkspaceData = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["data-status"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["companies"] }),
      queryClient.invalidateQueries({ queryKey: ["company"] }),
      queryClient.invalidateQueries({ queryKey: ["drafts"] }),
      queryClient.invalidateQueries({ queryKey: ["source-runs"] }),
      queryClient.invalidateQueries({ queryKey: ["settings"] }),
      queryClient.invalidateQueries({ queryKey: ["gmail-status"] }),
    ]);

  useEffect(() => {
    if (!settings.data) return;
    const incoming = fromResponse(settings.data);
    setForm((current) => {
      if (!formHydrated.current) {
        formHydrated.current = true;
        return incoming;
      }
      const merged = { ...current };
      for (const key of Object.keys(incoming) as Array<keyof AppSettings>) {
        if (!dirtyFields.current.has(key)) {
          (merged[key] as AppSettings[typeof key]) = incoming[key];
        }
      }
      return merged;
    });
  }, [settings.data]);

  const sectionFields: Record<string, Array<keyof AppSettings>> = {
    scope: [
      "scopeLocation",
      "employeeMin",
      "employeeMax",
      "industries",
      "jobFreshnessDays",
      "jobRefreshDays",
      "maxEvidenceAgeDays",
      "companySitePageLimit",
      "technologyOnlyDataSf",
      "autoPrioritizeHiring",
      "emailFreshnessDays",
      "catchAllPolicy",
      "secondVerifier",
      "excludeSocialJustice",
    ],
    rate: [
      "hourlyCap",
      "dailyCap",
      "sendWindowStart",
      "sendWindowEnd",
      "sendDays",
      "timeZone",
      "noResponseWaitDays",
      "bouncePauseEnabled",
      "bounceThreshold",
      "sendingEnabled",
    ],
    identity: [
      "senderName",
      "organizationName",
      "postalAddress",
      "optOutText",
      "replyHandlingNote",
      "complianceConfirmed",
    ],
  };

  const saveMutation = useMutation({
    mutationFn: ({
      values,
    }: {
      section: string;
      values: Record<string, unknown>;
    }) => api.patchSettings(values),
    onSuccess: async (_, variables) => {
      for (const key of sectionFields[variables.section] || []) {
        dirtyFields.current.delete(key);
      }
      setSavedSection(variables.section);
      window.setTimeout(() => setSavedSection(null), 1_800);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["gmail-status"] }),
      ]);
    },
  });
  const gmailAuthMutation = useMutation({
    mutationFn: api.gmailAuthUrl,
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
  const gmailDisconnectMutation = useMutation({
    mutationFn: api.gmailDisconnect,
    onSuccess: async () => {
      dirtyFields.current.delete("sendingEnabled");
      setForm((current) => ({ ...current, sendingEnabled: false }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["gmail-status"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
  });
  const gmailTestMutation = useMutation({
    mutationFn: api.gmailTest,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["gmail-status"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
  });
  const openFolderMutation = useMutation({
    mutationFn: api.openDataFolder,
    onSuccess: () => setDataMessage("Opened the local data folder."),
  });
  const backupMutation = useMutation({
    mutationFn: api.createBackup,
    onSuccess: async (backup) => {
      setDataMessage(`Backup created: ${backup.fileName}`);
      await queryClient.invalidateQueries({ queryKey: ["data-status"] });
    },
  });
  const compactMutation = useMutation({
    mutationFn: api.compactData,
    onSuccess: async () => {
      setDataMessage("Database compacted successfully.");
      await queryClient.invalidateQueries({ queryKey: ["data-status"] });
    },
  });
  const inspectBackupMutation = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 500 * 1_024 * 1_024) {
        throw new Error("Backup exceeds the 500 MB local restore limit.");
      }
      const backupText = await file.text();
      const inspection = await api.inspectBackup(backupText);
      return { backupText, fileName: file.name, inspection };
    },
    onSuccess: (candidate) => {
      setRestoreCandidate(candidate);
      setRestoreConfirmation("");
      setRestoreOpen(true);
    },
  });
  const restoreMutation = useMutation({
    mutationFn: () => {
      if (!restoreCandidate) throw new Error("Choose a backup file first.");
      return api.restoreBackup(
        restoreCandidate.backupText,
        restoreConfirmation,
      );
    },
    onSuccess: async (result) => {
      setRestoreOpen(false);
      setRestoreConfirmation("");
      setRestoreCandidate(null);
      setDataMessage(
        `Local data restored. A safety backup was saved as ${result.preRestoreBackup}.`,
      );
      dirtyFields.current.clear();
      await invalidateWorkspaceData();
    },
  });

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    dirtyFields.current.add(key);
    setForm((current) => ({ ...current, [key]: value }));
  }

  function closeRestore() {
    setRestoreOpen(false);
    setRestoreConfirmation("");
    setRestoreCandidate(null);
    restoreMutation.reset();
  }

  function saveValues(section: string, values: Record<string, unknown>) {
    saveMutation.mutate({ section, values });
  }

  const connection = (key: string) =>
    settings.data?.connections.find((item) => item.key === key);
  const gmailClient = connection("GOOGLE_CLIENT_ID");
  const gmailSecret = connection("GOOGLE_CLIENT_SECRET");
  const savedForm = settings.data ? fromResponse(settings.data) : defaults;
  const complianceReady = Boolean(
    savedForm.senderName.trim() &&
      savedForm.postalAddress.trim() &&
      savedForm.optOutText.trim() &&
      savedForm.complianceConfirmed,
  );
  const configuredProviders = useMemo(
    () =>
      settings.data?.connections.filter(
        (item) =>
          item.configured &&
          !["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].includes(item.key),
      ).length || 0,
    [settings.data],
  );
  const lastBackup = backupMutation.data || dataStatus.data?.lastBackup;
  const dataActionError =
    openFolderMutation.error ||
    backupMutation.error ||
    compactMutation.error ||
    inspectBackupMutation.error;

  if (settings.isLoading) {
    return (
      <div className="page">
        <PageHeader
          description="Local preferences, provider keys, and delivery safeguards."
          title="Settings"
        />
        <div className="page-loading">
          <Spinner label="Loading settings" />
        </div>
      </div>
    );
  }

  return (
    <div className="page page--settings">
      <PageHeader
        description="Configure the few defaults that govern research quality and local data."
        meta={<Badge tone="neutral">{configuredProviders} research providers connected</Badge>}
        title="Settings"
      />

      {settings.error ? (
        <InlineNotice tone="danger">{settings.error.message}</InlineNotice>
      ) : null}
      {saveMutation.error ? (
        <InlineNotice tone="danger">{saveMutation.error.message}</InlineNotice>
      ) : null}
      {gmailAuthMutation.error ||
      gmailDisconnectMutation.error ||
      gmailTestMutation.error ? (
        <InlineNotice tone="danger">
          {(
            gmailAuthMutation.error ||
            gmailDisconnectMutation.error ||
            gmailTestMutation.error
          )?.message}
        </InlineNotice>
      ) : null}
      {gmail.error ? (
        <InlineNotice tone="danger">Gmail status: {gmail.error.message}</InlineNotice>
      ) : null}
      {searchParams.get("gmail") === "connected" ? (
        <InlineNotice tone="success">
          <span>
            <strong>Gmail connected.</strong> Confirm the sender safeguards below before
            enabling one-at-a-time sends.
          </span>
          <Button onClick={() => setSearchParams({})} variant="ghost">
            Dismiss
          </Button>
        </InlineNotice>
      ) : null}
      {searchParams.get("gmail") === "error" ? (
        <InlineNotice tone="danger">
          <span>
            Gmail authorization did not complete. Check the OAuth client and redirect
            URI, then try again.
          </span>
          <Button onClick={() => setSearchParams({})} variant="ghost">
            Dismiss
          </Button>
        </InlineNotice>
      ) : null}

      <div className="settings-stack">
        <SettingSection
          description="Defaults used to qualify the company universe and mark evidence stale."
          icon={MapPin}
          title="Research scope"
        >
          <div className="settings-form-grid">
            <label className="field field--wide">
              <span>Market</span>
              <Input
                onChange={(event) => update("scopeLocation", event.target.value)}
                value={form.scopeLocation}
              />
            </label>
            <label className="field">
              <span>Minimum employees</span>
              <Input
                max={1000}
                min={3}
                onChange={(event) => update("employeeMin", event.target.value)}
                type="number"
                value={form.employeeMin}
              />
            </label>
            <label className="field">
              <span>Maximum employees</span>
              <Input
                max={1000}
                min={3}
                onChange={(event) => update("employeeMax", event.target.value)}
                type="number"
                value={form.employeeMax}
              />
            </label>
            <label className="field field--wide">
              <span>Technology industries</span>
              <Input
                onChange={(event) => update("industries", event.target.value)}
                value={form.industries}
              />
              <small>Comma-separated categories used as research defaults.</small>
            </label>
            <label className="field">
              <span>Hiring signal window</span>
              <div className="input-suffix">
                <Input
                  max={180}
                  min={30}
                  onChange={(event) => update("jobFreshnessDays", event.target.value)}
                  type="number"
                  value={form.jobFreshnessDays}
                />
                <span>days</span>
              </div>
            </label>
            <label className="field">
              <span>Refresh hiring after</span>
              <div className="input-suffix">
                <Input
                  max={365}
                  min={7}
                  onChange={(event) => update("jobRefreshDays", event.target.value)}
                  type="number"
                  value={form.jobRefreshDays}
                />
                <span>days</span>
              </div>
            </label>
            <label className="field">
              <span>Maximum evidence age</span>
              <div className="input-suffix">
                <Input
                  max={365}
                  min={30}
                  onChange={(event) =>
                    update("maxEvidenceAgeDays", event.target.value)
                  }
                  type="number"
                  value={form.maxEvidenceAgeDays}
                />
                <span>days</span>
              </div>
            </label>
            <label className="field">
              <span>Company-site page limit</span>
              <Input
                max={20}
                min={1}
                onChange={(event) =>
                  update("companySitePageLimit", event.target.value)
                }
                type="number"
                value={form.companySitePageLimit}
              />
              <small>Robots rules and a hard maximum of 20 still apply.</small>
            </label>
            <label className="field">
              <span>Email verification window</span>
              <div className="input-suffix">
                <Input
                  max={30}
                  min={1}
                  onChange={(event) => update("emailFreshnessDays", event.target.value)}
                  type="number"
                  value={form.emailFreshnessDays}
                />
                <span>days</span>
              </div>
            </label>
            <label className="field">
              <span>Second verifier</span>
              <select
                className="select"
                onChange={(event) => update("secondVerifier", event.target.value)}
                value={form.secondVerifier}
              >
                <option value="none">None</option>
                <option
                  disabled={!connection("ZEROBOUNCE_API_KEY")?.configured}
                  value="zerobounce"
                >
                  ZeroBounce
                </option>
              </select>
            </label>
            <div className="field field--wide">
              <Checkbox
                checked={form.technologyOnlyDataSf}
                label="Use technology-only classifications for DataSF by default"
                onCheckedChange={(value) =>
                  update("technologyOnlyDataSf", value)
                }
              />
            </div>
            <div className="field field--wide">
              <Checkbox
                checked={form.autoPrioritizeHiring}
                label="Auto-prioritize companies with current hiring evidence"
                onCheckedChange={(value) =>
                  update("autoPrioritizeHiring", value)
                }
              />
            </div>
            <label className="field">
              <span>Catch-all emails</span>
              <select
                className="select"
                onChange={(event) => update("catchAllPolicy", event.target.value)}
                value={form.catchAllPolicy}
              >
                <option value="review">Hold for manual review</option>
                <option value="exclude">Exclude from outreach</option>
                <option value="allow_last_resort">Keep as reviewed fallback lead</option>
              </select>
              <small>Catch-all addresses never satisfy Gmail send readiness.</small>
            </label>
            <div className="field field--wide">
              <Checkbox
                checked={form.excludeSocialJustice}
                label="Flag publicly advocacy-oriented company missions for manual fit review"
                onCheckedChange={(value) => update("excludeSocialJustice", value)}
              />
            </div>
          </div>
          <div className="settings-actions">
            {savedSection === "scope" ? (
              <span className="save-confirmation">
                <Check size={14} /> Saved
              </span>
            ) : null}
            <Button
              disabled={saveMutation.isPending}
              onClick={() =>
                saveValues("scope", {
                  scopeLocation: form.scopeLocation,
                  employeeMin: Number(form.employeeMin),
                  employeeMax: Number(form.employeeMax),
                  industries: form.industries
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                  jobFreshnessDays: Number(form.jobFreshnessDays),
                  jobRefreshDays: Number(form.jobRefreshDays),
                  maxEvidenceAgeDays: Number(form.maxEvidenceAgeDays),
                  companySitePageLimit: Number(form.companySitePageLimit),
                  technologyOnlyDataSf: form.technologyOnlyDataSf,
                  autoPrioritizeHiring: form.autoPrioritizeHiring,
                  emailFreshnessDays: Number(form.emailFreshnessDays),
                  catchAllPolicy: form.catchAllPolicy,
                  secondVerifier: form.secondVerifier,
                  excludeSocialJustice: form.excludeSocialJustice,
                })
              }
              variant="primary"
            >
              <Save size={15} />
              Save scope
            </Button>
            <Button
              disabled={saveMutation.isPending}
              onClick={() => {
                if (
                  !window.confirm(
                    "Restore safe research defaults for future runs? Existing records and evidence will not change.",
                  )
                ) {
                  return;
                }
                setForm((current) => ({
                  ...current,
                  scopeLocation: defaults.scopeLocation,
                  employeeMin: defaults.employeeMin,
                  employeeMax: defaults.employeeMax,
                  industries: defaults.industries,
                  jobFreshnessDays: defaults.jobFreshnessDays,
                  jobRefreshDays: defaults.jobRefreshDays,
                  maxEvidenceAgeDays: defaults.maxEvidenceAgeDays,
                  companySitePageLimit: defaults.companySitePageLimit,
                  technologyOnlyDataSf: defaults.technologyOnlyDataSf,
                  autoPrioritizeHiring: defaults.autoPrioritizeHiring,
                  emailFreshnessDays: defaults.emailFreshnessDays,
                  catchAllPolicy: defaults.catchAllPolicy,
                  secondVerifier: defaults.secondVerifier,
                  excludeSocialJustice: defaults.excludeSocialJustice,
                }));
                saveValues("scope", {
                  scopeLocation: defaults.scopeLocation,
                  employeeMin: Number(defaults.employeeMin),
                  employeeMax: Number(defaults.employeeMax),
                  industries: defaults.industries
                    .split(",")
                    .map((item) => item.trim()),
                  jobFreshnessDays: Number(defaults.jobFreshnessDays),
                  jobRefreshDays: Number(defaults.jobRefreshDays),
                  maxEvidenceAgeDays: Number(defaults.maxEvidenceAgeDays),
                  companySitePageLimit: Number(defaults.companySitePageLimit),
                  technologyOnlyDataSf: defaults.technologyOnlyDataSf,
                  autoPrioritizeHiring: defaults.autoPrioritizeHiring,
                  emailFreshnessDays: Number(defaults.emailFreshnessDays),
                  catchAllPolicy: defaults.catchAllPolicy,
                  secondVerifier: defaults.secondVerifier,
                  excludeSocialJustice: defaults.excludeSocialJustice,
                });
              }}
              variant="ghost"
            >
              Restore safe defaults
            </Button>
          </div>
        </SettingSection>

        <SettingSection
          description="Licensed enrichment and optional API capacity. Keys stay on this computer."
          icon={Link2}
          title="Research connections"
        >
          <div className="connection-list">
            {providers.map((provider) => {
              const status = connection(provider.key);
              return (
                <div className="connection-row" key={provider.key}>
                  <span className="connection-row__icon">
                    <KeyRound size={17} />
                  </span>
                  <div>
                    <div className="connection-title">
                      <strong>{provider.label}</strong>
                      <a
                        aria-label={`${provider.label} documentation`}
                        href={provider.href}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <ExternalLink size={13} />
                      </a>
                    </div>
                    <p>{provider.purpose}</p>
                  </div>
                  <div className="connection-row__status">
                    <Badge tone={status?.configured ? "success" : "neutral"}>
                      {status?.configured
                        ? `Connected · ${status.source}`
                        : "Not configured"}
                    </Badge>
                    <div className="button-group">
                      <ProviderTestButton
                        configured={Boolean(status?.configured)}
                        provider={provider}
                      />
                      <ProviderDialog
                        configured={Boolean(status?.configured)}
                        provider={provider}
                        source={status?.source || null}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <InlineNotice tone="info">
            Public DataSF, Hacker News, Greenhouse, Lever, Ashby, and company-web
            research work without paid credentials.
          </InlineNotice>
        </SettingSection>

        <SettingSection
          description="OAuth and explicit one-at-a-time sends use the Gmail API. There is no bulk-send scheduler."
          icon={Mail}
          title="Gmail and rate limits"
        >
          <div className="gmail-status">
            <div className="gmail-status__main">
              <span className="connection-row__icon">
                <Mail size={18} />
              </span>
              <div>
                <div className="connection-title">
                  <strong>Gmail API</strong>
                  <Badge
                    tone={
                      gmail.data?.connected
                        ? "success"
                        : gmail.data?.configured
                          ? "warning"
                        : "neutral"
                    }
                  >
                    {gmail.data?.connected
                      ? `Connected · ${gmail.data.accountEmail || "Gmail"}`
                      : gmail.data?.configured
                        ? "Credentials saved · connect account"
                        : "Not configured"}
                  </Badge>
                </div>
                <p>
                  Bring your own Google Desktop OAuth client. No browser cookies are
                  accepted or stored.
                </p>
              </div>
            </div>
            <div className="button-group">
              <GoogleCredentialsDialog
                clientConfigured={Boolean(gmailClient?.configured)}
                secretConfigured={Boolean(gmailSecret?.configured)}
              />
              {gmail.data?.connected ? (
                <>
                  <Button
                    disabled={gmailAuthMutation.isPending}
                    onClick={() => gmailAuthMutation.mutate()}
                    variant="ghost"
                  >
                    <Link2 size={15} />
                    Reconnect
                  </Button>
                  <Button
                    disabled={gmailDisconnectMutation.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Disconnect Gmail? Drafts, history, and provider credentials will remain, but sending will be disabled.",
                        )
                      ) {
                        gmailDisconnectMutation.mutate();
                      }
                    }}
                    variant="ghost"
                  >
                    <Unplug size={15} />
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  disabled={!gmail.data?.configured || gmailAuthMutation.isPending}
                  onClick={() => gmailAuthMutation.mutate()}
                  variant="primary"
                >
                  <Link2 size={15} />
                  Connect Gmail
                </Button>
              )}
            </div>
          </div>
          <InlineNotice tone="info">
            <LockKeyhole size={16} />
            Sending requires an approved company, reviewed contact, approved draft, and
            valid email verified within {form.emailFreshnessDays} days. Reply, bounce,
            and no-response outcomes are recorded manually; no inbox-read scope is used.
          </InlineNotice>
          {gmailTestMutation.data ? (
            <InlineNotice tone="success">
              Test sent to {gmailTestMutation.data.sentTo}. Gmail sending can now
              be enabled after the remaining gates pass.
            </InlineNotice>
          ) : null}
          <div className="settings-form-grid">
            <label className="field">
              <span>Hourly ceiling</span>
              <div className="input-suffix">
                <Input
                  max={20}
                  min={1}
                  onChange={(event) => update("hourlyCap", event.target.value)}
                  type="number"
                  value={form.hourlyCap}
                />
                <span>emails</span>
              </div>
              <small>Hard maximum: 20</small>
            </label>
            <label className="field">
              <span>Daily ceiling</span>
              <div className="input-suffix">
                <Input
                  max={400}
                  min={1}
                  onChange={(event) => update("dailyCap", event.target.value)}
                  type="number"
                  value={form.dailyCap}
                />
                <span>emails</span>
              </div>
            </label>
            <label className="field">
              <span>Start sending after</span>
              <select
                className="select"
                onChange={(event) => update("sendWindowStart", event.target.value)}
                value={form.sendWindowStart}
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>
                    {new Intl.DateTimeFormat(undefined, {
                      hour: "numeric",
                      timeZone: "UTC",
                    }).format(new Date(Date.UTC(2020, 0, 1, hour)))}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Stop sending at</span>
              <select
                className="select"
                onChange={(event) => update("sendWindowEnd", event.target.value)}
                value={form.sendWindowEnd}
              >
                {Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => (
                  <option key={hour} value={hour}>
                    {hour === 24
                      ? "12 AM (midnight)"
                      : new Intl.DateTimeFormat(undefined, {
                          hour: "numeric",
                          timeZone: "UTC",
                        }).format(new Date(Date.UTC(2020, 0, 1, hour)))}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>No-response wait</span>
              <div className="input-suffix">
                <Input
                  max={90}
                  min={1}
                  onChange={(event) =>
                    update("noResponseWaitDays", event.target.value)
                  }
                  type="number"
                  value={form.noResponseWaitDays}
                />
                <span>days</span>
              </div>
            </label>
            <label className="field">
              <span>Time zone</span>
              <Input
                onChange={(event) => update("timeZone", event.target.value)}
                value={form.timeZone}
              />
              <small>IANA zone used for weekdays and sending hours.</small>
            </label>
            <div className="field field--wide">
              <span>Sending days</span>
              <div className="weekday-grid">
                {weekdays.map(([day, label]) => (
                  <Checkbox
                    checked={form.sendDays.includes(day)}
                    key={day}
                    label={label}
                    onCheckedChange={(checked) =>
                      update(
                        "sendDays",
                        checked
                          ? Array.from(new Set([...form.sendDays, day]))
                          : form.sendDays.filter((value) => value !== day),
                      )
                    }
                  />
                ))}
              </div>
            </div>
            <div className="field">
              <Checkbox
                checked={form.bouncePauseEnabled}
                label="Pause sending after repeated manual bounce outcomes"
                onCheckedChange={(value) =>
                  update("bouncePauseEnabled", value)
                }
              />
            </div>
            {form.bouncePauseEnabled ? (
              <label className="field">
                <span>Bounce threshold</span>
                <Input
                  max={20}
                  min={1}
                  onChange={(event) =>
                    update("bounceThreshold", event.target.value)
                  }
                  type="number"
                  value={form.bounceThreshold}
                />
              </label>
            ) : null}
            <div className="field field--wide">
              <Checkbox
                checked={form.sendingEnabled}
                disabled={
                  !gmail.data?.connected ||
                  !gmail.data.complianceReady ||
                  !gmail.data.testPassed
                }
                label="Enable explicit Gmail sends after all readiness checks pass"
                onCheckedChange={(value) => {
                  if (
                    value &&
                    !window.confirm(
                      "Enable only explicit, one-at-a-time Gmail sends? This does not schedule or send any existing draft.",
                    )
                  ) {
                    return;
                  }
                  update("sendingEnabled", value);
                }}
              />
            </div>
          </div>
          {gmail.data ? (
            <div className="gmail-usage">
              <span>
                <strong>{gmail.data.usage.sentLastHour}</strong> sent this hour
              </span>
              <span>
                <strong>{gmail.data.usage.sentToday}</strong> sent today
              </span>
              <span>
                <strong>{gmail.data.missingRequirements.length}</strong> readiness blocks
              </span>
            </div>
          ) : null}
          <div className="settings-actions">
            {savedSection === "rate" ? (
              <span className="save-confirmation">
                <Check size={14} /> Saved
              </span>
            ) : null}
            <Button
              disabled={saveMutation.isPending || Number(form.hourlyCap) > 20}
              onClick={() =>
                saveValues("rate", {
                  gmail_hourly_cap: Number(form.hourlyCap),
                  gmail_daily_cap: Number(form.dailyCap),
                  sending_window_start: Number(form.sendWindowStart),
                  sending_window_end: Number(form.sendWindowEnd),
                  no_response_wait_days: Number(form.noResponseWaitDays),
                  sending_days: form.sendDays,
                  time_zone: form.timeZone,
                  bounce_pause_enabled: form.bouncePauseEnabled,
                  bounce_threshold: Number(form.bounceThreshold),
                  gmail_sending_enabled: form.sendingEnabled,
                })
              }
            >
              <Gauge size={15} />
              Save limits
            </Button>
            <Button
              disabled={
                !gmail.data?.connected ||
                !gmail.data.complianceReady ||
                gmailTestMutation.isPending
              }
              onClick={() => {
                if (
                  window.confirm(
                    `Send one RecruitAI connection test to ${gmail.data?.accountEmail || "your connected Gmail account"}?`,
                  )
                ) {
                  gmailTestMutation.mutate();
                }
              }}
              variant="primary"
            >
              <Mail size={15} />
              {gmailTestMutation.isPending
                ? "Sending test…"
                : gmail.data?.testPassed
                  ? "Send test again"
                  : "Send test to myself"}
            </Button>
          </div>
        </SettingSection>

        <SettingSection
          description="Required sender details are appended or checked before delivery can ever be enabled."
          icon={ShieldCheck}
          title="Sender identity"
        >
          <div className="settings-form-grid">
            <label className="field">
              <span>Sender name</span>
              <Input
                onChange={(event) => update("senderName", event.target.value)}
                placeholder="Your full name"
                value={form.senderName}
              />
            </label>
            <label className="field">
              <span>Organization / trading name</span>
              <Input
                onChange={(event) =>
                  update("organizationName", event.target.value)
                }
                value={form.organizationName}
              />
            </label>
            <label className="field field--wide">
              <span>Valid postal address</span>
              <Textarea
                onChange={(event) => update("postalAddress", event.target.value)}
                placeholder="Business or registered postal address"
                rows={2}
                value={form.postalAddress}
              />
            </label>
            <label className="field field--wide">
              <span>Opt-out line</span>
              <Textarea
                onChange={(event) => update("optOutText", event.target.value)}
                rows={2}
                value={form.optOutText}
              />
            </label>
            <label className="field field--wide">
              <span>Reply handling note (internal)</span>
              <Textarea
                onChange={(event) =>
                  update("replyHandlingNote", event.target.value)
                }
                placeholder="How you will monitor and record replies"
                rows={2}
                value={form.replyHandlingNote}
              />
            </label>
            <div className="field field--wide">
              <Checkbox
                checked={form.complianceConfirmed}
                label="I confirm each message will use truthful sender details and honor opt-out requests"
                onCheckedChange={(value) => update("complianceConfirmed", value)}
              />
            </div>
          </div>
          <div className="compliance-state">
            {complianceReady ? (
              <Badge tone="success">Sender identity complete</Badge>
            ) : (
              <Badge tone="warning">Required before sending</Badge>
            )}
            <p>
              Commercial one-to-one outreach still requires truthful headers, a valid
              postal address, and a clear opt-out process.
            </p>
          </div>
          <div className="settings-actions">
            {savedSection === "identity" ? (
              <span className="save-confirmation">
                <Check size={14} /> Saved
              </span>
            ) : null}
            <Button
              disabled={saveMutation.isPending}
              onClick={() =>
                saveValues("identity", {
                  sender_name: form.senderName,
                  organization_name: form.organizationName,
                  postal_address: form.postalAddress,
                  opt_out_text: form.optOutText,
                  reply_handling_note: form.replyHandlingNote,
                  compliance_confirmed: form.complianceConfirmed,
                })
              }
              variant="primary"
            >
              <Save size={15} />
              Save identity
            </Button>
          </div>
        </SettingSection>

        <SettingSection
          description="Inspect, back up, restore, and maintain the SQLite database and saved evidence snapshots."
          icon={HardDrive}
          title="Local data"
        >
          <input
            accept=".json,application/json"
            aria-label="Choose a RecruitAI backup"
            className="visually-hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              setDataMessage(null);
              inspectBackupMutation.reset();
              inspectBackupMutation.mutate(file);
            }}
            ref={restoreFileInput}
            type="file"
          />

          {dataStatus.isLoading ? (
            <div className="local-data-loading">
              <Spinner label="Loading local data status" />
            </div>
          ) : dataStatus.error ? (
            <InlineNotice tone="danger">
              Local data status could not be loaded: {dataStatus.error.message}
            </InlineNotice>
          ) : dataStatus.data ? (
            <>
              <div className="local-data-paths">
                <div className="local-data-path">
                  <span className="local-data-icon">
                    <HardDrive size={18} />
                  </span>
                  <div>
                    <strong>Data folder</strong>
                    <code title={dataStatus.data.dataDirectory}>
                      {dataStatus.data.dataDirectory}
                    </code>
                  </div>
                </div>
                <div className="local-data-path">
                  <span className="local-data-icon">
                    <Database size={18} />
                  </span>
                  <div>
                    <strong>SQLite database</strong>
                    <code title={dataStatus.data.databasePath}>
                      {dataStatus.data.databasePath}
                    </code>
                  </div>
                </div>
              </div>

              <dl className="local-data-summary" aria-label="Local data summary">
                <div>
                  <dt>Companies</dt>
                  <dd>{dataStatus.data.counts.companies.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Contacts</dt>
                  <dd>{dataStatus.data.counts.contacts.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Jobs</dt>
                  <dd>{dataStatus.data.counts.jobs.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Evidence</dt>
                  <dd>{dataStatus.data.counts.evidence.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Database</dt>
                  <dd>{formatBytes(dataStatus.data.databaseBytes)}</dd>
                </div>
                <div>
                  <dt>Snapshots</dt>
                  <dd>{formatBytes(dataStatus.data.snapshotBytes)}</dd>
                </div>
                <div>
                  <dt>Backups</dt>
                  <dd>
                    {formatBytes(dataStatus.data.backupBytes)}
                    <small>{dataStatus.data.backups.length} saved</small>
                  </dd>
                </div>
              </dl>

              <div className="local-data-runtime">
                <span>RecruitAI {dataStatus.data.appVersion}</span>
                <span>{dataStatus.data.runtime}</span>
              </div>

              <div className="local-backup-row">
                <span className="local-data-icon">
                  <FileLock2 size={18} />
                </span>
                <div>
                  <strong>Last full backup</strong>
                  {lastBackup ? (
                    <p>
                      {formatDataDate(lastBackup.createdAt)} ·{" "}
                      {formatBytes(lastBackup.bytes)}
                      {lastBackup.snapshotCount == null
                        ? ""
                        : ` · ${lastBackup.snapshotCount.toLocaleString()} snapshots`}
                    </p>
                  ) : (
                    <p>No local backup has been created yet.</p>
                  )}
                </div>
                {lastBackup ? (
                  <a
                    className="button button--secondary"
                    download={lastBackup.fileName}
                    href={lastBackup.downloadUrl}
                  >
                    <ArrowDownToLine size={15} />
                    Download
                  </a>
                ) : null}
              </div>
            </>
          ) : null}

          {dataMessage ? (
            <InlineNotice tone="success">{dataMessage}</InlineNotice>
          ) : null}
          {dataActionError ? (
            <InlineNotice tone="danger">{dataActionError.message}</InlineNotice>
          ) : null}

          <div className="local-data-actions" aria-label="Local data actions">
            <Button
              disabled={backupMutation.isPending || dataStatus.isLoading}
              onClick={() => {
                setDataMessage(null);
                backupMutation.mutate();
              }}
              variant="primary"
            >
              <FileLock2 size={15} />
              {backupMutation.isPending ? "Creating backup…" : "Create backup"}
            </Button>
            <Button
              disabled={inspectBackupMutation.isPending}
              onClick={() => restoreFileInput.current?.click()}
            >
              <Upload size={15} />
              {inspectBackupMutation.isPending ? "Inspecting…" : "Restore backup"}
            </Button>
            <Button
              disabled={compactMutation.isPending || dataStatus.isLoading}
              onClick={() => {
                setDataMessage(null);
                compactMutation.mutate();
              }}
              variant="ghost"
            >
              <RefreshCw size={15} />
              {compactMutation.isPending ? "Compacting…" : "Compact database"}
            </Button>
            <Button
              disabled={openFolderMutation.isPending}
              onClick={() => {
                setDataMessage(null);
                openFolderMutation.mutate();
              }}
              variant="ghost"
            >
              <FolderOpen size={15} />
              {openFolderMutation.isPending ? "Opening…" : "Open data folder"}
            </Button>
          </div>

          <InlineNotice tone="info">
            Full backups contain the SQLite database and saved evidence snapshots. They
            also contain locally saved provider credentials and the Gmail refresh token.
            Treat each backup as sensitive; it remains in the local backups folder until
            you remove it.
          </InlineNotice>

          <div className="local-data-danger">
            <div className="local-data-danger__heading">
              <div>
                <h3>Data cleanup</h3>
                <p>
                  These actions remove local records. Typed confirmation prevents
                  accidental clicks.
                </p>
              </div>
              <div className="local-data-danger__actions">
                <TypedConfirmationDialog
                  action={async () => {
                    const result = await api.clearDemoData("CLEAR DEMO DATA");
                    setDataMessage(
                      result.recoveryBackup
                        ? `Removed ${result.removedCompanies} fictional companies. Recovery backup: ${result.recoveryBackup}.`
                        : "No fictional demo companies were found.",
                    );
                    await invalidateWorkspaceData();
                  }}
                  confirmLabel="Clear demo data"
                  description="Remove fictional .example companies and their dependent records. Other researched data remains."
                  disabled={dataStatus.isLoading}
                  phrase="CLEAR DEMO DATA"
                  title="Clear fictional demo data?"
                  triggerIcon={<Trash2 size={15} />}
                  triggerLabel="Clear demo data"
                  triggerVariant="secondary"
                />
                <TypedConfirmationDialog
                  action={async () => {
                    const result = await api.deleteAllData("DELETE LOCAL DATA");
                    setDataMessage(
                      `Working data was deleted. Recovery backup: ${result.recoveryBackup}.`,
                    );
                    dirtyFields.current.clear();
                    await invalidateWorkspaceData();
                  }}
                  confirmLabel="Delete local data"
                  description="Delete working records, settings, provider secrets, and snapshots. RecruitAI creates a recovery backup first and keeps backup files on disk."
                  disabled={dataStatus.isLoading}
                  phrase="DELETE LOCAL DATA"
                  title="Delete all local working data?"
                  triggerIcon={<Trash2 size={15} />}
                  triggerLabel="Delete all data"
                />
              </div>
            </div>
          </div>

          <div className="settings-actions settings-actions--spread">
            <div className="local-only-label">
              <LockKeyhole size={14} />
              Bound to this computer at 127.0.0.1
            </div>
            <a className="button button--secondary" href="/api/export/contacts.csv">
              <ArrowDownToLine size={15} />
              Export contacts CSV
            </a>
          </div>

          <Dialog
            description="Review the selected backup before replacing current local data. RecruitAI creates a safety backup of the current workspace first."
            onOpenChange={(open) => {
              if (open) setRestoreOpen(true);
              else closeRestore();
            }}
            open={restoreOpen}
            title="Restore local data?"
          >
            <form
              className="dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                restoreMutation.mutate();
              }}
            >
              {restoreCandidate ? (
                <div className="restore-preview">
                  <div className="restore-preview__file">
                    <span className="local-data-icon">
                      <Upload size={18} />
                    </span>
                    <div>
                      <strong>{restoreCandidate.fileName}</strong>
                      <small>Compatible RecruitAI backup</small>
                    </div>
                  </div>
                  <dl>
                    <div>
                      <dt>Created</dt>
                      <dd>
                        {formatDataDate(restoreCandidate.inspection.createdAt)}
                      </dd>
                    </div>
                    <div>
                      <dt>Source app</dt>
                      <dd>{restoreCandidate.inspection.appVersion}</dd>
                    </div>
                    <div>
                      <dt>Format</dt>
                      <dd>
                        {restoreCandidate.inspection.format} v
                        {restoreCandidate.inspection.version}
                      </dd>
                    </div>
                    <div>
                      <dt>Database</dt>
                      <dd>
                        {formatBytes(restoreCandidate.inspection.databaseBytes)}
                      </dd>
                    </div>
                    <div>
                      <dt>Snapshots</dt>
                      <dd>
                        {restoreCandidate.inspection.snapshotCount.toLocaleString()}
                      </dd>
                    </div>
                  </dl>
                </div>
              ) : null}
              <label className="field">
                <span>
                  Type{" "}
                  <code className="confirmation-phrase">
                    RESTORE LOCAL DATA
                  </code>{" "}
                  to confirm
                </span>
                <Input
                  autoComplete="off"
                  autoFocus
                  onChange={(event) =>
                    setRestoreConfirmation(event.target.value)
                  }
                  spellCheck={false}
                  value={restoreConfirmation}
                />
              </label>
              {restoreMutation.error ? (
                <InlineNotice tone="danger">
                  {restoreMutation.error.message}
                </InlineNotice>
              ) : null}
              <div className="dialog-actions">
                <Button onClick={closeRestore}>Cancel</Button>
                <Button
                  disabled={
                    !restoreCandidate ||
                    restoreConfirmation !== "RESTORE LOCAL DATA" ||
                    restoreMutation.isPending
                  }
                  type="submit"
                  variant="danger"
                >
                  {restoreMutation.isPending
                    ? "Restoring…"
                    : "Restore local data"}
                </Button>
              </div>
            </form>
          </Dialog>
        </SettingSection>
      </div>
    </div>
  );
}
