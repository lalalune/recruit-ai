import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  FilePenLine,
  LockKeyhole,
  Mail,
  Save,
  Send,
  Settings2,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OutreachDraft } from "../../shared/types";
import { PageHeader } from "../components/PageHeader";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  InlineNotice,
  Input,
  Spinner,
  Textarea,
} from "../components/ui";
import { api } from "../lib/api";
import { Link, useParams, useSearchParams } from "../lib/router";

type DraftFilter = "active" | "approved" | "all";

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusTone(status: OutreachDraft["status"]) {
  if (["sent", "replied"].includes(status)) return "success" as const;
  if (["bounced", "send_unknown"].includes(status)) return "danger" as const;
  if (["approved", "gmail_draft", "scheduled"].includes(status)) return "info" as const;
  return "neutral" as const;
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function DraftQueueRow({
  draft,
  active,
  queryString,
}: {
  draft: OutreachDraft;
  active: boolean;
  queryString: string;
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`draft-queue-row ${active ? "is-active" : ""}`}
      to={`/outreach/${draft.id}${queryString ? `?${queryString}` : ""}`}
    >
      <div className="draft-queue-row__heading">
        <strong>{draft.companyName}</strong>
        <Badge tone={statusTone(draft.status)}>{titleCase(draft.status)}</Badge>
      </div>
      <span>{draft.contactName}</span>
      <p>{draft.subject}</p>
      <small>Edited {formatDate(draft.updatedAt)}</small>
    </Link>
  );
}

function ChecklistItem({
  complete,
  label,
  detail,
}: {
  complete: boolean;
  label: string;
  detail: string;
}) {
  return (
    <li className={complete ? "is-complete" : ""}>
      {complete ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
    </li>
  );
}

function DraftWorkspace({
  draft,
  queueQuery,
}: {
  draft: OutreachDraft;
  queueQuery: string;
}) {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [copyLabel, setCopyLabel] = useState("Copy");
  const [confirmSend, setConfirmSend] = useState(false);
  const [outcome, setOutcome] = useState<
    "replied" | "bounced" | "no_response" | null
  >(null);
  const [outcomeNote, setOutcomeNote] = useState("");
  const [sendResolution, setSendResolution] = useState<
    "sent" | "not_sent" | null
  >(null);
  const [resolutionNote, setResolutionNote] = useState("");

  useEffect(() => {
    setSubject(draft.subject);
    setBody(draft.body);
  }, [draft.id, draft.body, draft.subject]);

  const company = useQuery({
    queryKey: ["company", draft.companyId],
    queryFn: () => api.company(draft.companyId),
  });
  const gmail = useQuery({ queryKey: ["gmail-status"], queryFn: api.gmailStatus });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const saveMutation = useMutation({
    mutationFn: (status?: OutreachDraft["status"]) =>
      api.patchDraft(draft.id, {
        subject,
        body,
        ...(status
          ? { status }
          : draft.status === "approved"
            ? { status: "draft" }
            : {}),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["drafts"] }),
        queryClient.invalidateQueries({ queryKey: ["draft", draft.id] }),
      ]);
    },
  });
  const sendMutation = useMutation({
    mutationFn: () => api.sendDraft(draft.id),
    onSuccess: () => {
      setConfirmSend(false);
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["drafts"] }),
        queryClient.invalidateQueries({ queryKey: ["draft", draft.id] }),
        queryClient.invalidateQueries({ queryKey: ["gmail-status"] }),
        queryClient.invalidateQueries({ queryKey: ["company", draft.companyId] }),
      ]);
    },
  });
  const outcomeMutation = useMutation({
    mutationFn: () =>
      api.recordDraftOutcome(
        draft.id,
        outcome as "replied" | "bounced" | "no_response",
        outcomeNote || undefined,
      ),
    onSuccess: () => {
      setOutcome(null);
      setOutcomeNote("");
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["drafts"] }),
        queryClient.invalidateQueries({ queryKey: ["company", draft.companyId] }),
      ]);
    },
  });
  const resolveSendMutation = useMutation({
    mutationFn: () =>
      api.resolveUnknownSend(
        draft.id,
        sendResolution as "sent" | "not_sent",
        resolutionNote,
      ),
    onSuccess: () => {
      setSendResolution(null);
      setResolutionNote("");
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["drafts"] }),
        queryClient.invalidateQueries({ queryKey: ["draft", draft.id] }),
        queryClient.invalidateQueries({
          queryKey: ["company", draft.companyId],
        }),
        queryClient.invalidateQueries({ queryKey: ["gmail-status"] }),
      ]);
    },
  });
  useEffect(() => {
    if (outcome !== null) return;
    setOutcomeNote("");
    outcomeMutation.reset();
  }, [outcome]);
  useEffect(() => {
    setOutcome(null);
    setOutcomeNote("");
    outcomeMutation.reset();
    setSendResolution(null);
    setResolutionNote("");
    resolveSendMutation.reset();
  }, [draft.id]);

  const contact = company.data?.contacts.find((item) => item.id === draft.contactId);
  const validEmail = contact?.emailStatus === "valid";
  const verificationFreshnessDays =
    gmail.data?.limits.verificationFreshnessDays ?? 30;
  const verificationAge = contact?.emailVerifiedAt
    ? Date.now() - new Date(contact.emailVerifiedAt).getTime()
    : Number.NaN;
  const freshVerification =
    Number.isFinite(verificationAge) &&
    verificationAge >= -24 * 60 * 60 * 1_000 &&
    verificationAge <= verificationFreshnessDays * 24 * 60 * 60 * 1_000;
  const hasSenderPlaceholder = /\[your name\]/i.test(body);
  const contentReady = Boolean(
    subject.trim() && body.trim() && !hasSenderPlaceholder,
  );
  const complianceReady = Boolean(gmail.data?.complianceReady);
  const credentialsReady = Boolean(gmail.data?.configured && gmail.data.connected);
  const recordReady = Boolean(
    company.data?.reviewed &&
      company.data.status === "approved" &&
      contact?.reviewed,
  );
  const dirty = subject !== draft.subject || body !== draft.body;
  const editable = ["draft", "approved"].includes(draft.status);
  const allChecks = Boolean(
    validEmail &&
      freshVerification &&
      contentReady &&
      Boolean(draft.editedAt) &&
      complianceReady &&
      credentialsReady &&
      recordReady &&
      draft.status === "approved" &&
      !dirty &&
      gmail.data?.sendReady &&
      !company.isFetching &&
      !gmail.isFetching &&
      !settings.isFetching,
  );
  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
  const settingText = (key: string) => {
    const value = settings.data?.values[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const senderName = settingText("sender_name");
  const exactMessage = `${body.trim()}\n\n—\n${[
    senderName,
    settingText("organization_name"),
    settingText("postal_address"),
    settingText("opt_out_text"),
  ]
    .filter(Boolean)
    .join("\n")}`;

  async function copyDraft() {
    await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
    setCopyLabel("Copied");
    window.setTimeout(() => setCopyLabel("Copy"), 1_500);
  }

  return (
    <div className="draft-workspace">
      <header className="draft-header">
        <div>
          <Link
            className="mobile-back-link"
            to={`/outreach${queueQuery ? `?${queueQuery}` : ""}`}
          >
            <ArrowLeft size={15} />
            Drafts
          </Link>
          <div className="draft-title-row">
            <h2>{draft.companyName}</h2>
            <Badge tone={statusTone(draft.status)}>{titleCase(draft.status)}</Badge>
          </div>
          <p>
            <UserRound size={14} />
            {draft.contactName}
            <span aria-hidden="true">·</span>
            {contact?.email || "No current email"}
          </p>
        </div>
        <Link className="button button--secondary" to={`/review/${draft.companyId}`}>
          Open record
        </Link>
      </header>

      <div className="draft-layout">
        <section className="message-editor">
          <div className="message-editor__heading">
            <div>
              <h3>Message</h3>
              <p>One tailored note for one reviewed decision-maker.</p>
            </div>
            <span>{wordCount} words</span>
          </div>
          <label className="field">
            <span>Subject</span>
            <Input
              onChange={(event) => setSubject(event.target.value)}
              readOnly={!editable}
              value={subject}
            />
          </label>
          <label className="field field--grow">
            <span>Body</span>
            <Textarea
              onChange={(event) => setBody(event.target.value)}
              readOnly={!editable}
              spellCheck
              value={body}
            />
          </label>
          {saveMutation.error ? (
            <InlineNotice tone="danger">{saveMutation.error.message}</InlineNotice>
          ) : null}
          {draft.status === "send_unknown" ? (
            <div className="send-unknown-resolution">
              <InlineNotice tone="danger">
                Gmail delivery could not be confirmed. Check the connected
                account’s Sent folder before taking any further action.
              </InlineNotice>
              <div className="button-group">
                <Button
                  onClick={() => setSendResolution("sent")}
                  variant="secondary"
                >
                  Found in Sent
                </Button>
                <Button onClick={() => setSendResolution("not_sent")}>
                  Confirm not sent
                </Button>
              </div>
            </div>
          ) : null}
          <div className="message-editor__actions">
            <Button onClick={copyDraft}>
              <Copy size={15} />
              {copyLabel}
            </Button>
            {editable ? (
              <>
                <Button
                  disabled={!dirty || saveMutation.isPending || !contentReady}
                  onClick={() => saveMutation.mutate(undefined)}
                >
                  <Save size={15} />
                  {saveMutation.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
                </Button>
                <Button
                  disabled={
                    !contentReady ||
                    saveMutation.isPending ||
                    (draft.status !== "approved" && !dirty && !draft.editedAt)
                  }
                  onClick={() =>
                    saveMutation.mutate(
                      draft.status === "approved" ? "draft" : "approved",
                    )
                  }
                  variant={draft.status === "approved" ? "secondary" : "primary"}
                >
                  {draft.status === "approved" ? (
                    <>
                      <FilePenLine size={15} />
                      Return to draft
                    </>
                  ) : (
                    <>
                      <Check size={15} />
                      Approve draft
                    </>
                  )}
                </Button>
              </>
            ) : null}
          </div>
        </section>

        <aside className="send-readiness">
          {company.error || gmail.error || settings.error ? (
            <InlineNotice tone="danger">
              Send readiness could not be loaded:{" "}
              {(company.error || gmail.error || settings.error)?.message}
            </InlineNotice>
          ) : company.isLoading || gmail.isLoading || settings.isLoading ? (
            <InlineNotice tone="info">
              <Spinner label="Loading current send readiness" />
            </InlineNotice>
          ) : null}
          <div className="send-readiness__heading">
            <span className="send-readiness__icon">
              <ShieldCheck size={18} />
            </span>
            <div>
              <h3>Send readiness</h3>
              <p>Every check must pass before an outbound action can be enabled.</p>
            </div>
          </div>
          <ul className="readiness-list">
            <ChecklistItem
              complete={Boolean(validEmail && freshVerification)}
              detail={
                contact?.email
                  ? `${titleCase(contact.emailStatus)} · ${
                      contact.emailVerifiedAt
                        ? `checked ${formatDate(contact.emailVerifiedAt)}`
                        : "not dated"
                    }`
                  : "Find a work email in Review"
              }
              label="Verified recipient"
            />
            <ChecklistItem
              complete={Boolean(contact?.reviewed)}
              detail={
                contact?.reviewed
                  ? "Current role manually reviewed"
                  : "Confirm the person and current role in Review"
              }
              label="Decision-maker reviewed"
            />
            <ChecklistItem
              complete={Boolean(
                company.data?.reviewed && company.data.status === "approved",
              )}
              detail={
                company.data?.reviewed && company.data.status === "approved"
                  ? "Company research bundle approved"
                  : "Approve the company record in Review"
              }
              label="Company approved"
            />
            <ChecklistItem
              complete={contentReady && Boolean(draft.editedAt) && draft.status === "approved"}
              detail={
                !draft.editedAt
                  ? "Change the generated subject or body before approval"
                  : hasSenderPlaceholder
                    ? "Replace [Your name] before approval"
                  : draft.status === "approved"
                    ? "Message manually edited and explicitly approved"
                    : "Read and approve the edited draft"
              }
              label="Message edited and approved"
            />
            <ChecklistItem
              complete={complianceReady}
              detail={
                complianceReady
                  ? "Sender identity, postal address, and opt-out text saved"
                  : "Complete sender identity in Settings"
              }
              label="Sender identity"
            />
            <ChecklistItem
              complete={credentialsReady}
              detail={
                credentialsReady
                  ? `Connected as ${gmail.data?.accountEmail || "Gmail account"}`
                  : gmail.data?.configured
                    ? "Authorize a Gmail account in Settings"
                    : "Add Google OAuth desktop credentials"
              }
              label="Gmail connected"
            />
          </ul>

          <InlineNotice tone="info">
            <LockKeyhole size={16} />
            Sends happen only after you click through a final confirmation. There is no
            bulk scheduler. Outcomes are recorded manually; automatic reply or bounce
            sync is not included.
          </InlineNotice>

          <Dialog
            description={`This will immediately send one email to ${
              contact?.email || draft.contactName
            } from ${gmail.data?.accountEmail || "your connected Gmail account"}.`}
            onOpenChange={(open) => {
              setConfirmSend(open);
              if (open) {
                void Promise.all([
                  company.refetch(),
                  gmail.refetch(),
                  settings.refetch(),
                ]);
              }
            }}
            open={confirmSend}
            title="Send this approved message?"
            trigger={
              <Button
                className="send-button"
                disabled={!allChecks || sendMutation.isPending}
                variant="primary"
              >
                <Send size={16} />
                Send now with Gmail
              </Button>
            }
          >
            <div className="send-confirmation">
              <dl>
                <div>
                  <dt>From</dt>
                  <dd>
                    {senderName || "Sender not configured"}
                    {gmail.data?.accountEmail ? ` <${gmail.data.accountEmail}>` : ""}
                  </dd>
                </div>
                <div>
                  <dt>To</dt>
                  <dd>{contact?.email || "No current recipient"}</dd>
                </div>
                <div>
                  <dt>Subject</dt>
                  <dd>{subject}</dd>
                </div>
                <div>
                  <dt>Usage</dt>
                  <dd>
                    {gmail.data?.usage.sentLastHour || 0}/{gmail.data?.limits.hourlyCap || 20}
                    {" "}this hour
                  </dd>
                </div>
                <div>
                  <dt>Verified</dt>
                  <dd>
                    {contact?.emailVerifiedAt
                      ? `${formatDate(contact.emailVerifiedAt)} · valid for ${verificationFreshnessDays} days`
                      : "Not verified"}
                  </dd>
                </div>
              </dl>
              <div className="send-message-preview">
                <strong>Exact plain-text message</strong>
                <pre>{exactMessage}</pre>
              </div>
              <InlineNotice tone="warning">
                This action sends immediately and cannot be undone from RecruitAI.
              </InlineNotice>
              {sendMutation.error ? (
                <InlineNotice tone="danger">{sendMutation.error.message}</InlineNotice>
              ) : null}
              <div className="dialog-actions">
                <Button onClick={() => setConfirmSend(false)}>Cancel</Button>
                <Button
                  disabled={sendMutation.isPending || !allChecks}
                  onClick={() => sendMutation.mutate()}
                  variant="primary"
                >
                  <Send size={15} />
                  {sendMutation.isPending ? "Sending…" : "Send one email"}
                </Button>
              </div>
            </div>
          </Dialog>
          <Dialog
            description={
              sendResolution === "sent"
                ? "This records the attempt as sent and preserves it in history."
                : "This returns the approved draft only after you confirm no copy exists in Gmail Sent mail."
            }
            onOpenChange={(open) => {
              if (!open) {
                setSendResolution(null);
                setResolutionNote("");
                resolveSendMutation.reset();
              }
            }}
            open={sendResolution !== null}
            title={
              sendResolution === "sent"
                ? "Confirm message was sent"
                : "Confirm message was not sent"
            }
            trigger={<span aria-hidden="true" hidden />}
          >
            <div className="dialog-form">
              <label className="field">
                <span>Gmail check note</span>
                <Textarea
                  onChange={(event) => setResolutionNote(event.target.value)}
                  placeholder="For example: checked sender@gmail.com Sent mail at 2:15 PM"
                  rows={3}
                  value={resolutionNote}
                />
              </label>
              {resolveSendMutation.error ? (
                <InlineNotice tone="danger">
                  {resolveSendMutation.error.message}
                </InlineNotice>
              ) : null}
              <div className="dialog-actions">
                <Button
                  onClick={() => {
                    setSendResolution(null);
                    setResolutionNote("");
                    resolveSendMutation.reset();
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={
                    !resolutionNote.trim() || resolveSendMutation.isPending
                  }
                  onClick={() => resolveSendMutation.mutate()}
                  variant={sendResolution === "sent" ? "primary" : "secondary"}
                >
                  {resolveSendMutation.isPending
                    ? "Recording…"
                    : "Record resolution"}
                </Button>
              </div>
            </div>
          </Dialog>
          <Link className="text-link send-settings-link" to="/settings">
            <Settings2 size={14} />
            Review sending settings
          </Link>
          <div className="rate-limit-note">
            <Clock3 size={14} />
            Enforced guardrail: no more than 20 messages per hour, with manual approval
            and confirmation for each message.
          </div>
          {draft.status === "sent" ? (
            <div className="outcome-actions">
              <strong>Record outcome</strong>
              <div className="button-group">
                <Button onClick={() => setOutcome("replied")} variant="secondary">
                  Mark replied
                </Button>
                <Button onClick={() => setOutcome("no_response")}>
                  No response
                </Button>
                <Button onClick={() => setOutcome("bounced")} variant="danger">
                  Bounced
                </Button>
              </div>
            </div>
          ) : draft.outcomeAt ? (
            <InlineNotice tone={draft.status === "replied" ? "success" : "warning"}>
              <span>
                <strong>{titleCase(draft.status)}</strong>
                {draft.outcomeNote ? ` — ${draft.outcomeNote}` : ""}
              </span>
            </InlineNotice>
          ) : null}
          <Dialog
            description={
              outcome === "no_response"
                ? "This unlocks deliberate progression to a different primary decision-maker after the configured wait."
                : outcome === "bounced"
                  ? "This invalidates and suppresses the address before another route is researched."
                  : "A reply stops further company outreach."
            }
            onOpenChange={(open) => {
              if (!open) {
                setOutcome(null);
                setOutcomeNote("");
                outcomeMutation.reset();
              }
            }}
            open={Boolean(outcome)}
            title={`Mark ${outcome ? titleCase(outcome) : "outcome"}?`}
            trigger={<span aria-hidden="true" hidden />}
          >
            <div className="dialog-form">
              <label className="field">
                <span>Outcome note</span>
                <Textarea
                  onChange={(event) => setOutcomeNote(event.target.value)}
                  placeholder="Optional context retained in history"
                  rows={3}
                  value={outcomeNote}
                />
              </label>
              {outcomeMutation.error ? (
                <InlineNotice tone="danger">{outcomeMutation.error.message}</InlineNotice>
              ) : null}
              <div className="dialog-actions">
                <Button
                  onClick={() => {
                    setOutcome(null);
                    setOutcomeNote("");
                    outcomeMutation.reset();
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={outcomeMutation.isPending}
                  onClick={() => outcomeMutation.mutate()}
                  variant={outcome === "bounced" ? "danger" : "primary"}
                >
                  Confirm outcome
                </Button>
              </div>
            </div>
          </Dialog>
          {allChecks ? (
            <p className="muted-copy">
              All server-side readiness gates currently pass.
            </p>
          ) : gmail.data?.missingRequirements.length ? (
            <p className="muted-copy">
              Locked by: {gmail.data.missingRequirements.join(", ")}.
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

export function OutreachPage() {
  const { draftId } = useParams();
  const [urlParams, setUrlParams] = useSearchParams();
  const requestedFilter = urlParams.get("view");
  const filter: DraftFilter = ["active", "approved", "all"].includes(
    requestedFilter || "",
  )
    ? (requestedFilter as DraftFilter)
    : "active";
  const requestedPage = Number(urlParams.get("page"));
  const page =
    Number.isInteger(requestedPage) && requestedPage >= 0 ? requestedPage : 0;
  const pageSize = 50;
  const queueQuery = urlParams.toString();
  function setQueueState(nextFilter: DraftFilter, nextPage: number) {
    const next = new URLSearchParams();
    if (nextFilter !== "active") next.set("view", nextFilter);
    if (nextPage > 0) next.set("page", String(nextPage));
    setUrlParams(next);
  }
  const params = useMemo(
    () =>
      new URLSearchParams({
        view: filter,
        limit: String(pageSize),
        offset: String(page * pageSize),
      }),
    [filter, page],
  );
  const drafts = useQuery({
    queryKey: ["drafts", params.toString()],
    queryFn: () => api.drafts(params),
  });
  const directDraft = useQuery({
    enabled: Boolean(draftId),
    queryKey: ["draft", draftId],
    queryFn: () => api.draft(draftId as string),
  });
  const items = drafts.data?.data || [];
  const selected = draftId ? directDraft.data : items[0];

  return (
    <div className="page page--outreach">
      <PageHeader
        description="Edit and approve deliberate one-to-one messages. Nothing is sent automatically."
        meta={<Badge tone="neutral">Manual send only</Badge>}
        title="Outreach"
      />

      <div className={`outreach-layout ${draftId ? "has-selection" : ""}`}>
        <aside className="draft-queue">
          <div className="draft-queue__tools">
            <Mail size={16} />
            <strong>Drafts</strong>
            <select
              aria-label="Filter drafts"
              className="select select--compact"
              onChange={(event) => {
                setQueueState(event.target.value as DraftFilter, 0);
              }}
              value={filter}
            >
              <option value="active">Active</option>
              <option value="approved">Approved</option>
              <option value="all">All history</option>
            </select>
          </div>
          <div className="draft-queue__list">
            {drafts.isLoading ? (
              <div className="queue-loading">
                <Spinner label="Loading drafts" />
              </div>
            ) : drafts.error ? (
              <InlineNotice tone="danger">{drafts.error.message}</InlineNotice>
            ) : items.length ? (
              items.map((draft) => (
                <DraftQueueRow
                  active={selected?.id === draft.id}
                  draft={draft}
                  key={draft.id}
                  queryString={queueQuery}
                />
              ))
            ) : (
              <EmptyState
                action={
                  <Link className="button button--primary" to="/review">
                    Open review queue
                  </Link>
                }
                body="Create a tailored draft from a reviewed decision-maker."
                title="No drafts in this view"
              />
            )}
          </div>
          {drafts.data && drafts.data.meta.total > pageSize ? (
            <div className="queue-pagination">
              <Button
                aria-label="Previous draft page"
                disabled={page === 0}
                onClick={() => setQueueState(filter, Math.max(0, page - 1))}
                variant="ghost"
              >
                <ChevronLeft size={14} />
              </Button>
              <span>
                {page * pageSize + 1}–
                {Math.min((page + 1) * pageSize, drafts.data.meta.total)} of{" "}
                {drafts.data.meta.total}
              </span>
              <Button
                aria-label="Next draft page"
                disabled={(page + 1) * pageSize >= drafts.data.meta.total}
                onClick={() => setQueueState(filter, page + 1)}
                variant="ghost"
              >
                <ChevronRight size={14} />
              </Button>
            </div>
          ) : null}
        </aside>
        <section className="draft-workspace-panel">
          {directDraft.isLoading && draftId ? (
            <div className="workspace-loading">
              <Spinner label="Loading draft" />
            </div>
          ) : directDraft.error && draftId ? (
            <EmptyState
              action={
                <Link
                  className="button button--primary"
                  to={`/outreach${queueQuery ? `?${queueQuery}` : ""}`}
                >
                  Back to drafts
                </Link>
              }
              body={directDraft.error.message}
              title="Draft could not be opened"
            />
          ) : selected ? (
            <DraftWorkspace
              draft={selected}
              key={selected.id}
              queueQuery={queueQuery}
            />
          ) : (
            <EmptyState
              action={
                <Link className="button button--primary" to="/review">
                  Choose a company
                </Link>
              }
              body="Approve a company and generate a message from its primary contact."
              title="Select a draft"
            />
          )}
        </section>
      </div>
    </div>
  );
}
