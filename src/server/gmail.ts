import { createHash, randomBytes } from "node:crypto";
import {
  claimDraftForSend,
  getCompany,
  getDraft,
  getOutreachRateCounts,
  getSettings,
  isSuppressed,
  listCompanyOutreach,
  markDraftSendUnknown,
  markDraftSent,
  releaseDraftAfterSendFailure,
  saveSetting,
} from "./repository";
import { getSecret, saveSecrets } from "./secrets";

const gmailSendScope = "https://www.googleapis.com/auth/gmail.send";

interface OAuthPending {
  verifier: string;
  expiresAt: number;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

const pendingOAuth = new Map<string, OAuthPending>();
let sendChain: Promise<unknown> = Promise.resolve();

function base64Url(value: Uint8Array | string) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function appPort() {
  return Number(process.env.RECRUITAI_PORT || 4317);
}

function callbackUrl() {
  return `http://127.0.0.1:${appPort()}/api/gmail/callback`;
}

function appSettingsUrl(result: "connected" | "error") {
  const port = process.env.RECRUITAI_DEV === "1" ? 5173 : appPort();
  return `http://127.0.0.1:${port}/settings?gmail=${result}`;
}

function readNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const candidate = Number(value);
  return Number.isFinite(candidate)
    ? Math.min(maximum, Math.max(minimum, Math.floor(candidate)))
    : fallback;
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function safeTimeZone(value: unknown) {
  const fallback =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
  const candidate = readText(value) || fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function sendConfiguration() {
  const settings = getSettings();
  const verificationFreshnessDays = readNumber(
    settings.emailFreshnessDays,
    30,
    1,
    30,
  );
  return {
    senderName: readText(settings.sender_name),
    organizationName: readText(settings.organization_name),
    postalAddress: readText(settings.postal_address),
    optOutText: readText(settings.opt_out_text),
    complianceConfirmed: settings.compliance_confirmed === true,
    sendingEnabled: settings.gmail_sending_enabled === true,
    hourlyCap: readNumber(settings.gmail_hourly_cap, 20, 1, 20),
    dailyCap: readNumber(settings.gmail_daily_cap, 200, 1, 400),
    windowStart: readNumber(settings.sending_window_start, 8, 0, 23),
    windowEnd: readNumber(settings.sending_window_end, 20, 1, 24),
    sendingDays: Array.isArray(settings.sending_days)
      ? (settings.sending_days as number[]).filter(
          (day) => Number.isInteger(day) && day >= 0 && day <= 6,
        )
      : [1, 2, 3, 4, 5],
    timeZone: safeTimeZone(settings.time_zone),
    accountEmail: readText(settings.gmail_account_email) || null,
    testPassed: Boolean(settings.gmail_test_passed_at),
    verificationFreshnessDays,
  };
}

function currentZonedSchedule(timeZone: string) {
  const weekdayNumbers: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  return {
    day: weekdayNumbers[parts.find((part) => part.type === "weekday")?.value || ""],
    hour: Number(parts.find((part) => part.type === "hour")?.value),
  };
}

export function getGmailStatus() {
  const clientId = getSecret("GOOGLE_CLIENT_ID");
  const clientSecret = getSecret("GOOGLE_CLIENT_SECRET");
  const refreshToken = getSecret("GOOGLE_REFRESH_TOKEN");
  const config = sendConfiguration();
  const counts = getOutreachRateCounts(config.timeZone);
  const missingRequirements: string[] = [];
  if (!clientId || !clientSecret) missingRequirements.push("Google OAuth client");
  if (!refreshToken) missingRequirements.push("connected Gmail account");
  if (!config.senderName) missingRequirements.push("sender name");
  if (!config.postalAddress) missingRequirements.push("postal address");
  if (!config.optOutText) missingRequirements.push("opt-out instruction");
  if (!config.complianceConfirmed) missingRequirements.push("compliance confirmation");
  if (!config.testPassed) missingRequirements.push("successful test message");
  if (!config.sendingEnabled) missingRequirements.push("sending enabled");
  if (counts.sentLastHour >= config.hourlyCap) missingRequirements.push("hourly cap reached");
  if (counts.sentToday >= config.dailyCap) missingRequirements.push("daily cap reached");
  const { hour, day } = currentZonedSchedule(config.timeZone);
  if (!config.sendingDays.includes(day)) {
    missingRequirements.push("outside configured sending days");
  }
  if (hour < config.windowStart || hour >= config.windowEnd) {
    missingRequirements.push("outside sending window");
  }
  return {
    configured: Boolean(clientId && clientSecret),
    connected: Boolean(refreshToken),
    accountEmail: config.accountEmail,
    sendingEnabled: config.sendingEnabled,
    testPassed: config.testPassed,
    complianceReady:
      Boolean(config.senderName && config.postalAddress && config.optOutText) &&
      config.complianceConfirmed,
    sendReady: missingRequirements.length === 0,
    missingRequirements,
    limits: {
      hourlyCap: config.hourlyCap,
      dailyCap: config.dailyCap,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
      verificationFreshnessDays: config.verificationFreshnessDays,
      sendingDays: config.sendingDays,
      timeZone: config.timeZone,
    },
    usage: counts,
  };
}

export function createGmailAuthorizationUrl() {
  const clientId = getSecret("GOOGLE_CLIENT_ID");
  if (!clientId || !getSecret("GOOGLE_CLIENT_SECRET")) {
    throw new Error("Add the Google OAuth client ID and client secret in Settings first.");
  }
  const state = base64Url(randomBytes(24));
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  pendingOAuth.clear();
  pendingOAuth.set(state, {
    verifier,
    expiresAt: Date.now() + 10 * 60 * 1_000,
  });
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(),
    response_type: "code",
    scope: `openid email ${gmailSendScope}`,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

async function requestTokens(input: URLSearchParams) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: input,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description || payload.error || "Google did not issue an access token.",
    );
  }
  return payload;
}

export async function completeGmailAuthorization(code: string, state: string) {
  const pending = pendingOAuth.get(state);
  pendingOAuth.delete(state);
  if (!pending || pending.expiresAt < Date.now()) {
    throw new Error("The Gmail connection request expired. Start it again from Settings.");
  }
  const clientId = getSecret("GOOGLE_CLIENT_ID");
  const clientSecret = getSecret("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured.");
  const tokens = await requestTokens(
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl(),
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    }),
  );
  const refreshToken = tokens.refresh_token || getSecret("GOOGLE_REFRESH_TOKEN");
  if (!refreshToken) {
    throw new Error("Google did not return a refresh token. Reconnect and approve access.");
  }
  const userInfoResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const userInfo = (await userInfoResponse.json()) as { email?: string };
  if (!userInfoResponse.ok || !userInfo.email) {
    throw new Error("Gmail connected, but the account email could not be confirmed.");
  }
  saveSecrets({ GOOGLE_REFRESH_TOKEN: refreshToken });
  saveSetting("gmail_account_email", userInfo.email);
  saveSetting("gmail_test_passed_at", null);
  return { connected: true, email: userInfo.email };
}

export function disconnectGmail() {
  saveSecrets({ GOOGLE_REFRESH_TOKEN: null });
  saveSetting("gmail_account_email", null);
  saveSetting("gmail_sending_enabled", false);
  saveSetting("gmail_test_passed_at", null);
  return getGmailStatus();
}

async function accessTokenFromRefreshToken() {
  const clientId = getSecret("GOOGLE_CLIENT_ID");
  const clientSecret = getSecret("GOOGLE_CLIENT_SECRET");
  const refreshToken = getSecret("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Connect Gmail in Settings before sending.");
  }
  return (
    await requestTokens(
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    )
  ).access_token as string;
}

function safeHeader(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodedSubject(value: string) {
  return `=?UTF-8?B?${Buffer.from(safeHeader(value), "utf8").toString("base64")}?=`;
}

function messageRaw(
  fromEmail: string,
  fromName: string,
  to: string,
  subject: string,
  body: string,
) {
  const mime = [
    `From: ${encodedSubject(fromName)} <${safeHeader(fromEmail)}>`,
    `To: ${safeHeader(to)}`,
    `Subject: ${encodedSubject(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body.replace(/\r?\n/g, "\r\n"),
  ].join("\r\n");
  return base64Url(mime);
}

export async function sendGmailTestMessage() {
  const config = sendConfiguration();
  if (!config.accountEmail) throw new Error("Connect Gmail before sending a test.");
  if (
    !config.senderName ||
    !config.postalAddress ||
    !config.optOutText ||
    !config.complianceConfirmed
  ) {
    throw new Error("Complete and save sender identity before sending a test.");
  }
  const accessToken = await accessTokenFromRefreshToken();
  const body = [
    "RecruitAI Gmail connection test.",
    "",
    "This message confirms the local app can send one explicitly approved Gmail API request.",
    "",
    "—",
    config.senderName,
    ...(config.organizationName ? [config.organizationName] : []),
    config.postalAddress,
    config.optOutText,
  ].join("\n");
  let response: Response;
  try {
    response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          raw: messageRaw(
            config.accountEmail,
            config.senderName,
            config.accountEmail,
            "RecruitAI Gmail connection test",
            body,
          ),
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new Error(
      "The Gmail test result is unknown. Check Sent mail before trying again.",
    );
  }
  const payload = (await response.json()) as {
    id?: string;
    error?: { message?: string };
  };
  if (!response.ok || !payload.id) {
    throw new Error(payload.error?.message || "Gmail rejected the test message.");
  }
  saveSetting("gmail_test_passed_at", new Date().toISOString());
  saveSetting("gmail_test_message_id", payload.id);
  return {
    ok: true,
    messageId: payload.id,
    sentTo: config.accountEmail,
    testedAt: new Date().toISOString(),
  };
}

function assertDraftCanSend(draftId: string) {
  const status = getGmailStatus();
  if (!status.sendReady) {
    throw new Error(`Sending is locked: ${status.missingRequirements.join(", ")}.`);
  }
  const config = sendConfiguration();
  const draft = getDraft(draftId);
  if (!draft) throw new Error("Draft not found.");
  if (draft.status !== "approved") throw new Error("Approve the final draft before sending.");
  if (!draft.editedAt) {
    throw new Error("Edit the generated message before approving and sending it.");
  }
  if (/\[your name\]/i.test(draft.body)) {
    throw new Error("Replace the [Your name] placeholder before sending.");
  }
  const company = getCompany(draft.companyId);
  if (!company || !company.reviewed || company.status !== "approved") {
    throw new Error("Approve the reviewed company record before sending.");
  }
  const companyFit = company.readiness.find((item) => item.id === "company_fit");
  if (companyFit?.state !== "complete") {
    throw new Error(
      "Confirm Bay Area, technology, size, and outside-recruiting fit before sending.",
    );
  }
  const hiringNow = company.readiness.find((item) => item.id === "hiring_now");
  if (company.openRolesCount < 1 || hiringNow?.state !== "complete") {
    throw new Error("Refresh and confirm at least one current open role before sending.");
  }
  const evidenceFreshness = company.readiness.find(
    (item) => item.id === "evidence_freshness",
  );
  if (evidenceFreshness?.state !== "complete") {
    throw new Error("Refresh the company evidence before sending.");
  }
  if (company.conflictCount > 0) {
    throw new Error("Resolve company identity conflicts before sending.");
  }
  if (
    company.employeeCountMin === null ||
    company.employeeCountMax === null ||
    company.employeeCountMin < 3 ||
    company.employeeCountMin > company.employeeCountMax ||
    company.employeeCountMax > 1_000
  ) {
    throw new Error("Confirm that company size is within the 3–1,000 employee scope.");
  }
  const contact = company.contacts.find((item) => item.id === draft.contactId);
  if (!contact || !contact.reviewed) {
    throw new Error("Review the selected decision-maker before sending.");
  }
  if (
    !contact.employmentConfirmed ||
    !contact.observedTitle?.trim() ||
    !contact.employmentObservedAt
  ) {
    throw new Error(
      "Manually confirm this decision-maker's current title and observed date before sending.",
    );
  }
  const employmentAge = Date.now() - Date.parse(contact.employmentObservedAt);
  if (
    !Number.isFinite(employmentAge) ||
    employmentAge < -24 * 60 * 60 * 1_000 ||
    employmentAge > 180 * 24 * 60 * 60 * 1_000
  ) {
    throw new Error(
      "Reconfirm this decision-maker's current employment; the observation must be within six months.",
    );
  }
  if (contact.status !== "primary") {
    throw new Error("Only the current primary decision-maker can receive outreach.");
  }
  if (!contact.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
    throw new Error("The selected decision-maker needs a valid email address.");
  }
  if (contact.emailStatus !== "valid" || !contact.emailVerifiedAt) {
    throw new Error("Only recently verified valid emails can be sent.");
  }
  const verificationAge = Date.now() - Date.parse(contact.emailVerifiedAt);
  const verificationFreshnessMs =
    config.verificationFreshnessDays * 24 * 60 * 60 * 1_000;
  if (
    !Number.isFinite(verificationAge) ||
    verificationAge < -24 * 60 * 60 * 1_000 ||
    verificationAge > verificationFreshnessMs
  ) {
    throw new Error(
      `Reverify this email; its verification is older than ${config.verificationFreshnessDays} days.`,
    );
  }
  const domain = contact.email.split("@")[1];
  if (
    !domain ||
    ["example", "test", "invalid", "localhost"].some(
      (suffix) => domain === suffix || domain.endsWith(`.${suffix}`),
    )
  ) {
    throw new Error("Reserved demo and test domains can never receive outreach.");
  }
  if (
    isSuppressed(contact.email, "email") ||
    (domain ? isSuppressed(domain, "domain") : false) ||
    isSuppressed(contact.id, "person") ||
    isSuppressed(contact.fullName, "person") ||
    isSuppressed(company.id, "company") ||
    isSuppressed(company.name, "company")
  ) {
    throw new Error("This address or domain is suppressed.");
  }
  if (
    ["personal", "generic"].includes(contact.emailType) &&
    (!contact.fallbackConfirmed || !contact.fallbackReason?.trim())
  ) {
    throw new Error(
      "Document why a personal or generic address is the necessary fallback before sending.",
    );
  }
  const priorOutreach = listCompanyOutreach(company.id).filter(
    (item) => item.id !== draft.id,
  );
  if (priorOutreach.some((item) => item.status === "replied")) {
    throw new Error("This company has already replied; further outreach is blocked.");
  }
  const unresolved = priorOutreach.find((item) =>
    ["approved", "sending", "send_unknown", "sent"].includes(item.status),
  );
  if (unresolved) {
    throw new Error(
      `Resolve the existing ${unresolved.status.replace("_", " ")} outreach to ${unresolved.contactName} before contacting another person.`,
    );
  }
  if (
    priorOutreach.some(
      (item) =>
        item.contactId === contact.id &&
        ["no_response", "bounced"].includes(item.status),
    )
  ) {
    throw new Error(
      "Advance to a different primary decision-maker after a no-response or bounce outcome.",
    );
  }
  return { draft, contact };
}

async function sendOneDraft(draftId: string) {
  const { draft, contact } = assertDraftCanSend(draftId);
  const claimed = claimDraftForSend(draftId);
  if (!claimed) throw new Error("This draft is already being processed or is no longer approved.");
  const config = sendConfiguration();
  const footer = [
    config.senderName,
    config.organizationName || null,
    config.postalAddress,
    config.optOutText,
  ]
    .filter(Boolean)
    .join("\n");
  const completeBody = `${draft.body.trim()}\n\n—\n${footer}`;
  let requestStarted = false;
  let responseProvesNoAcceptance = false;
  try {
    const accessToken = await accessTokenFromRefreshToken();
    requestStarted = true;
    const response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          raw: messageRaw(
            config.accountEmail as string,
            config.senderName,
            contact.email as string,
            draft.subject,
            completeBody,
          ),
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    responseProvesNoAcceptance = response.status >= 400 && response.status < 500;
    const payload = (await response.json()) as {
      id?: string;
      threadId?: string;
      error?: { message?: string };
    };
    if (!response.ok || !payload.id) {
      throw new Error(payload.error?.message || "Gmail did not accept the message.");
    }
    return markDraftSent(draftId, payload.id, payload.threadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!requestStarted || responseProvesNoAcceptance) {
      releaseDraftAfterSendFailure(draftId, message);
      throw error;
    }
    markDraftSendUnknown(draftId, message);
    throw new Error(
      `${message} Delivery status is unknown; check Gmail before taking any further action for this contact.`,
    );
  }
}

export function sendApprovedDraft(draftId: string) {
  const operation = sendChain.then(() => sendOneDraft(draftId));
  sendChain = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export function gmailSettingsRedirect(result: "connected" | "error") {
  return appSettingsUrl(result);
}
