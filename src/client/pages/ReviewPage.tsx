import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  Ban,
  BriefcaseBusiness,
  Building2,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileCheck2,
  Filter,
  Globe2,
  History,
  Mail,
  MapPin,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "../lib/router";
import { safeExternalHref } from "../lib/urls";
import type {
  CompanyDetail,
  CompanyListItem,
  ContactSummary,
  EmailStatus,
  EvidenceItem,
} from "../../shared/types";
import { PageHeader } from "../components/PageHeader";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  IconButton,
  InlineNotice,
  Input,
  Spinner,
  Textarea,
  Tooltip,
} from "../components/ui";
import { api } from "../lib/api";

type ReviewView = "unreviewed" | "all" | "approved" | "needs_research";
type WorkspaceTab = "overview" | "people" | "evidence" | "history";

const reviewTabs: Array<{ value: WorkspaceTab; label: string; icon: typeof Building2 }> = [
  { value: "overview", label: "Company", icon: Building2 },
  { value: "people", label: "People", icon: UsersRound },
  { value: "evidence", label: "Evidence", icon: FileCheck2 },
  { value: "history", label: "History", icon: History },
];

function localDateValue(date = new Date()) {
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 10);
}

function displayDate(value: string | null, withTime = false) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}

function companySize(company: {
  employeeCountMin: number | null;
  employeeCountMax: number | null;
}) {
  if (company.employeeCountMin == null && company.employeeCountMax == null) return "Size unknown";
  if (company.employeeCountMin === company.employeeCountMax) {
    return `${company.employeeCountMin} employees`;
  }
  return `${company.employeeCountMin ?? "?"}–${company.employeeCountMax ?? "?"} employees`;
}

function emailTone(status: EmailStatus): "success" | "warning" | "danger" | "neutral" {
  if (status === "valid") return "success";
  if (["invalid", "disposable", "do_not_mail"].includes(status)) return "danger";
  if (["accept_all", "unknown"].includes(status)) return "warning";
  return "neutral";
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function scoreLabel(score: number) {
  if (score >= 70) return "Strong hiring signal";
  if (score >= 40) return "Active hiring signal";
  return "Limited hiring evidence";
}

function SourceLinks({ company }: { company: CompanyDetail }) {
  const links = [
    safeExternalHref(company.websiteUrl)
      ? {
          label: "Website",
          href: safeExternalHref(company.websiteUrl) as string,
          icon: Globe2,
        }
      : null,
    safeExternalHref(company.linkedinUrl)
      ? {
          label: "LinkedIn",
          href: safeExternalHref(company.linkedinUrl) as string,
          icon: UsersRound,
        }
      : null,
    safeExternalHref(company.ycUrl)
      ? {
          label: "YC profile",
          href: safeExternalHref(company.ycUrl) as string,
          icon: Sparkles,
        }
      : null,
  ].filter(Boolean) as Array<{ label: string; href: string; icon: typeof Globe2 }>;

  if (!links.length) return <span className="muted-copy">No company links confirmed.</span>;
  return (
    <div className="record-links">
      {links.map(({ label, href, icon: Icon }) => (
        <a href={href} key={label} rel="noreferrer" target="_blank">
          <Icon size={14} />
          {label}
          <ArrowUpRight size={13} />
        </a>
      ))}
    </div>
  );
}

function QueueRow({
  company,
  active,
  queryString,
}: {
  company: CompanyListItem;
  active: boolean;
  queryString: string;
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`queue-row ${active ? "is-active" : ""}`}
      to={`/review/${company.id}${queryString ? `?${queryString}` : ""}`}
    >
      <div className="queue-row__top">
        <strong>{company.name}</strong>
        {company.conflictCount ? (
          <Tooltip label={`${company.conflictCount} conflicting evidence item(s)`}>
            <span className="conflict-mark" aria-label="Conflicting evidence">
              <CircleAlert size={15} />
            </span>
          </Tooltip>
        ) : null}
      </div>
      <div className="queue-row__meta">
        <span>{company.location || "Location unknown"}</span>
        <span aria-hidden="true">·</span>
        <span>{company.openRolesCount} open</span>
      </div>
      <div className="queue-row__bottom">
        <span className="signal-score">
          <span aria-hidden="true" style={{ width: `${Math.min(company.hiringScore, 100)}%` }} />
          {company.hiringScore}
        </span>
        {company.primaryContact ? (
          <span className="queue-contact">
            {company.primaryContact.fullName}
            {company.primaryContact.emailStatus === "valid" ? (
              <CheckCircle2 size={13} aria-label="Verified email" />
            ) : null}
          </span>
        ) : (
          <span className="queue-contact is-missing">Decision-maker needed</span>
        )}
      </div>
    </Link>
  );
}

function CompanyEditor({
  company,
  open,
  onOpenChange,
}: {
  company: CompanyDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: company.name,
    domain: company.domain || "",
    websiteUrl: company.websiteUrl || "",
    linkedinUrl: company.linkedinUrl || "",
    ycUrl: company.ycUrl || "",
    description: company.description || "",
    location: company.location || "",
    employeeCountMin: company.employeeCountMin?.toString() || "",
    employeeCountMax: company.employeeCountMax?.toString() || "",
    industries: company.industries.join(", "),
    stage: company.stage || "",
    priority: company.priority,
    fitConfirmed: company.fitConfirmed,
    recruitingFit: company.recruitingFit,
    recruitingFitNote: company.recruitingFitNote || "",
    notes: company.notes || "",
    reviewed: false,
  });

  useEffect(() => {
    setForm({
      name: company.name,
      domain: company.domain || "",
      websiteUrl: company.websiteUrl || "",
      linkedinUrl: company.linkedinUrl || "",
      ycUrl: company.ycUrl || "",
      description: company.description || "",
      location: company.location || "",
      employeeCountMin: company.employeeCountMin?.toString() || "",
      employeeCountMax: company.employeeCountMax?.toString() || "",
      industries: company.industries.join(", "),
      stage: company.stage || "",
      priority: company.priority,
      fitConfirmed: company.fitConfirmed,
      recruitingFit: company.recruitingFit,
      recruitingFitNote: company.recruitingFitNote || "",
      notes: company.notes || "",
      reviewed: false,
    });
  }, [company, open]);

  const mutation = useMutation({
    mutationFn: () =>
      api.patchCompany(company.id, {
        name: form.name,
        domain: form.domain || null,
        websiteUrl: form.websiteUrl || null,
        linkedinUrl: form.linkedinUrl || null,
        ycUrl: form.ycUrl || null,
        description: form.description || null,
        location: form.location || null,
        employeeCountMin: form.employeeCountMin ? Number(form.employeeCountMin) : null,
        employeeCountMax: form.employeeCountMax ? Number(form.employeeCountMax) : null,
        industries: form.industries
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        stage: form.stage || null,
        priority: form.priority,
        fitConfirmed: form.fitConfirmed,
        recruitingFit: form.recruitingFit,
        recruitingFitNote: form.recruitingFitNote || null,
        notes: form.notes || null,
        reviewed: form.reviewed,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["company", company.id] }),
        queryClient.invalidateQueries({ queryKey: ["companies"] }),
      ]);
      onOpenChange(false);
    },
  });

  function update(key: keyof typeof form, value: string | boolean) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <Dialog
      description="Correct normalized facts here. The source trail remains unchanged."
      onOpenChange={onOpenChange}
      open={open}
      title="Edit company"
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <div className="form-grid">
          <label className="field field--wide">
            <span>Company name</span>
            <Input onChange={(event) => update("name", event.target.value)} value={form.name} />
          </label>
          <label className="field">
            <span>Domain</span>
            <Input
              onChange={(event) => update("domain", event.target.value)}
              placeholder="example.com"
              value={form.domain}
            />
          </label>
          <label className="field">
            <span>Location</span>
            <Input
              onChange={(event) => update("location", event.target.value)}
              placeholder="San Francisco, CA"
              value={form.location}
            />
          </label>
          <label className="field">
            <span>Website</span>
            <Input
              onChange={(event) => update("websiteUrl", event.target.value)}
              placeholder="https://"
              type="url"
              value={form.websiteUrl}
            />
          </label>
          <label className="field">
            <span>LinkedIn company URL</span>
            <Input
              onChange={(event) => update("linkedinUrl", event.target.value)}
              placeholder="https://www.linkedin.com/company/…"
              type="url"
              value={form.linkedinUrl}
            />
          </label>
          <label className="field">
            <span>YC profile</span>
            <Input
              onChange={(event) => update("ycUrl", event.target.value)}
              placeholder="https://www.ycombinator.com/companies/…"
              type="url"
              value={form.ycUrl}
            />
          </label>
          <label className="field">
            <span>Stage</span>
            <Input
              onChange={(event) => update("stage", event.target.value)}
              placeholder="Seed, Series A…"
              value={form.stage}
            />
          </label>
          <label className="field">
            <span>Minimum employees</span>
            <Input
              min={0}
              onChange={(event) => update("employeeCountMin", event.target.value)}
              type="number"
              value={form.employeeCountMin}
            />
          </label>
          <label className="field">
            <span>Maximum employees</span>
            <Input
              min={0}
              onChange={(event) => update("employeeCountMax", event.target.value)}
              type="number"
              value={form.employeeCountMax}
            />
          </label>
          <label className="field">
            <span>Priority</span>
            <select
              className="select"
              onChange={(event) => update("priority", event.target.value)}
              value={form.priority}
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label className="field field--wide">
            <span>Industries</span>
            <Input
              onChange={(event) => update("industries", event.target.value)}
              placeholder="AI, robotics, manufacturing"
              value={form.industries}
            />
            <small>Comma-separated</small>
          </label>
          <label className="field field--wide">
            <span>Description</span>
            <Textarea
              onChange={(event) => update("description", event.target.value)}
              rows={3}
              value={form.description}
            />
          </label>
          <label className="field">
            <span>Outside recruiting fit</span>
            <select
              className="select"
              onChange={(event) => update("recruitingFit", event.target.value)}
              value={form.recruitingFit}
            >
              <option value="unknown">Needs research</option>
              <option value="likely">Likely to use outside recruiting</option>
              <option value="unlikely">Likely handled internally</option>
              <option value="excluded">Not a recruiting-services fit</option>
            </select>
          </label>
          <label className="field field--wide">
            <span>Recruiting-fit note</span>
            <Textarea
              onChange={(event) => update("recruitingFitNote", event.target.value)}
              placeholder="For example: 18-person startup, no internal recruiter visible"
              rows={2}
              value={form.recruitingFitNote}
            />
          </label>
          <div className="field field--wide">
            <Checkbox
              checked={form.fitConfirmed}
              label="I confirmed Bay Area, technology, 3–1,000 employees, and company-level fit"
              onCheckedChange={(value) => update("fitConfirmed", value)}
            />
          </div>
          <label className="field field--wide">
            <span>Internal notes</span>
            <Textarea
              onChange={(event) => update("notes", event.target.value)}
              rows={3}
              value={form.notes}
            />
          </label>
          <div className="field field--wide">
            <Checkbox
              checked={form.reviewed}
              label="I reviewed the normalized company facts"
              onCheckedChange={(value) =>
                setForm((current) => ({ ...current, reviewed: value }))
              }
            />
          </div>
        </div>
        {mutation.error ? (
          <InlineNotice tone="danger">{mutation.error.message}</InlineNotice>
        ) : null}
        <div className="dialog-actions">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={mutation.isPending} type="submit" variant="primary">
            {mutation.isPending ? "Saving…" : "Save company"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface ContactFormState {
  fullName: string;
  title: string;
  roleCategory: string;
  email: string;
  emailType: ContactSummary["emailType"];
  fallbackReason: string;
  fallbackConfirmed: boolean;
  phone: string;
  phoneType: ContactSummary["phoneType"];
  phoneConfirmed: boolean;
  phoneSource: string;
  linkedinUrl: string;
  employmentConfirmed: boolean;
  observedTitle: string;
  employmentObservedAt: string;
  rank: string;
  status: ContactSummary["status"];
  notes: string;
  reviewed: boolean;
}

function contactForm(contact?: ContactSummary): ContactFormState {
  return {
    fullName: contact?.fullName || "",
    title: contact?.title || "",
    roleCategory: contact?.roleCategory || "",
    email: contact?.email || "",
    emailType: contact?.emailType || "work",
    fallbackReason: contact?.fallbackReason || "",
    fallbackConfirmed: contact?.fallbackConfirmed || false,
    phone: contact?.phone || "",
    phoneType: contact?.phoneType || "unknown",
    phoneConfirmed: contact?.phoneConfirmed || false,
    phoneSource: contact?.phoneSource || "",
    linkedinUrl: contact?.linkedinUrl || "",
    employmentConfirmed: contact?.employmentConfirmed || false,
    observedTitle: contact?.observedTitle || contact?.title || "",
    employmentObservedAt: contact?.employmentObservedAt?.slice(0, 10) || "",
    rank: contact?.rank.toString() || "1",
    status: contact?.status || "candidate",
    notes: contact?.notes || "",
    reviewed: false,
  };
}

function ContactEditor({
  companyId,
  companyName,
  contact,
  open,
  onOpenChange,
}: {
  companyId: string;
  companyName: string;
  contact?: ContactSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ContactFormState>(() => contactForm(contact));

  useEffect(() => setForm(contactForm(contact)), [contact, open]);

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        fullName: form.fullName,
        title: form.title || null,
        roleCategory: form.roleCategory || null,
        email: form.email || null,
        emailType: form.emailType,
        fallbackReason: form.fallbackReason || null,
        fallbackConfirmed: form.fallbackConfirmed,
        phone: form.phone || null,
        phoneType: form.phoneType,
        phoneConfirmed: form.phone ? form.phoneConfirmed : false,
        phoneSource: form.phone ? form.phoneSource || null : null,
        linkedinUrl: form.linkedinUrl || null,
        employmentConfirmed: form.employmentConfirmed,
        observedTitle: form.observedTitle || null,
        employmentObservedAt: form.employmentObservedAt || null,
        rank: Number(form.rank) || 1,
        status: form.status,
        notes: form.notes || null,
        reviewed: form.reviewed,
      };
      return contact ? api.patchContact(contact.id, body) : api.addContact(companyId, body);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["company", companyId] }),
        queryClient.invalidateQueries({ queryKey: ["companies"] }),
        queryClient.invalidateQueries({ queryKey: ["drafts"] }),
      ]);
      onOpenChange(false);
    },
  });

  function update<K extends keyof ContactFormState>(key: K, value: ContactFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <Dialog
      description="Use confirmed professional information. Personal details should be a last resort."
      onOpenChange={onOpenChange}
      open={open}
      title={contact ? `Edit ${contact.fullName}` : "Add decision-maker"}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            form.status === "suppressed" &&
            contact?.status !== "suppressed" &&
            !window.confirm(
              `Suppress ${form.fullName || "this person"} and block the saved email from outreach? The history will be retained.`,
            )
          ) {
            return;
          }
          if (
            form.status === "primary" &&
            contact?.status !== "primary" &&
            !window.confirm(
              `Make ${form.fullName || "this person"} the sole primary decision-maker? Any current primary will become an alternate.`,
            )
          ) {
            return;
          }
          mutation.mutate();
        }}
      >
        <div className="form-grid">
          <label className="field field--wide">
            <span>Full name</span>
            <Input
              autoFocus
              onChange={(event) => update("fullName", event.target.value)}
              required
              value={form.fullName}
            />
          </label>
          <label className="field">
            <span>Title</span>
            <Input
              onChange={(event) => update("title", event.target.value)}
              placeholder="CEO, Head of People…"
              value={form.title}
            />
          </label>
          <label className="field">
            <span>Role category</span>
            <select
              className="select"
              onChange={(event) => update("roleCategory", event.target.value)}
              value={form.roleCategory}
            >
              <option value="">Select category</option>
              <option value="founder">Founder / CEO</option>
              <option value="operations">Operations</option>
              <option value="people">People</option>
              <option value="talent">Talent / recruiting</option>
              <option value="functional_leader">Functional leader</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="field">
            <span>Work email</span>
            <Input
              onChange={(event) => update("email", event.target.value)}
              placeholder="name@company.com"
              type="email"
              value={form.email}
            />
          </label>
          {form.phone ? (
            <>
              <label className="field field--wide">
                <span>Phone source URL or note</span>
                <Input
                  onChange={(event) => update("phoneSource", event.target.value)}
                  placeholder="Where you manually confirmed this number"
                  value={form.phoneSource}
                />
              </label>
              <div className="field field--wide">
                <Checkbox
                  checked={form.phoneConfirmed}
                  label="I manually confirmed this phone number exists"
                  onCheckedChange={(value) => update("phoneConfirmed", value)}
                />
              </div>
            </>
          ) : null}
          <label className="field">
            <span>Email type</span>
            <select
              className="select"
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  emailType: event.target.value as ContactSummary["emailType"],
                  fallbackReason:
                    event.target.value === "work" ? "" : current.fallbackReason,
                  fallbackConfirmed:
                    event.target.value === "work"
                      ? false
                      : current.fallbackConfirmed,
                }))
              }
              value={form.emailType}
            >
              <option value="work">Work</option>
              <option value="personal">Personal</option>
              <option value="generic">Generic</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          {form.email &&
          (form.emailType === "personal" || form.emailType === "generic") ? (
            <>
              <label className="field">
                <span>Fallback reason</span>
                <select
                  className="select"
                  onChange={(event) =>
                    update("fallbackReason", event.target.value)
                  }
                  value={form.fallbackReason}
                >
                  <option value="">Select reason</option>
                  <option value="No work email found">No work email found</option>
                  <option value="Founder uses this domain for business">
                    Founder uses this domain for business
                  </option>
                  <option value="Published as a business contact">
                    Published as a business contact
                  </option>
                  <option value="Confirmed generic fallback">
                    Confirmed generic fallback
                  </option>
                  <option value="Other documented business reason">Other</option>
                </select>
              </label>
              <div className="field">
                <Checkbox
                  checked={form.fallbackConfirmed}
                  label="Use only because no preferred work route is available"
                  onCheckedChange={(value) =>
                    update("fallbackConfirmed", value)
                  }
                />
              </div>
            </>
          ) : null}
          <label className="field">
            <span>Phone</span>
            <Input
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  phone: event.target.value,
                  phoneConfirmed:
                    event.target.value === contact?.phone
                      ? contact?.phoneConfirmed || false
                      : false,
                }))
              }
              placeholder="Manual confirmation only"
              type="tel"
              value={form.phone}
            />
          </label>
          <label className="field">
            <span>Phone type</span>
            <select
              className="select"
              onChange={(event) =>
                update("phoneType", event.target.value as ContactSummary["phoneType"])
              }
              value={form.phoneType}
            >
              <option value="unknown">Unknown</option>
              <option value="business">Business</option>
              <option value="direct">Direct</option>
              <option value="mobile">Mobile</option>
              <option value="switchboard">Switchboard</option>
            </select>
          </label>
          <label className="field field--wide">
            <span>LinkedIn profile (manual)</span>
            <Input
              onChange={(event) => update("linkedinUrl", event.target.value)}
              placeholder="Paste a manually confirmed profile URL"
              type="url"
              value={form.linkedinUrl}
            />
            <small>
              <a
                href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
                  `${form.fullName} ${companyName}`,
                )}`}
                rel="noreferrer"
                target="_blank"
              >
                Open a manual LinkedIn search <ArrowUpRight size={12} />
              </a>
            </small>
          </label>
          <label className="field">
            <span>Observed current title</span>
            <Input
              onChange={(event) => update("observedTitle", event.target.value)}
              placeholder="Title shown in the public source"
              value={form.observedTitle}
            />
          </label>
          <label className="field">
            <span>Employment observed on</span>
            <Input
              max={localDateValue()}
              onChange={(event) =>
                update("employmentObservedAt", event.target.value)
              }
              type="date"
              value={form.employmentObservedAt}
            />
          </label>
          <div className="field field--wide">
            <Checkbox
              checked={form.employmentConfirmed}
              label="I manually confirmed this person currently works at this company"
              onCheckedChange={(value) =>
                update("employmentConfirmed", value)
              }
            />
          </div>
          <label className="field">
            <span>Contact order</span>
            <Input
              max={99}
              min={1}
              onChange={(event) => update("rank", event.target.value)}
              type="number"
              value={form.rank}
            />
          </label>
          <label className="field">
            <span>Contact status</span>
            <select
              className="select"
              onChange={(event) =>
                update("status", event.target.value as ContactSummary["status"])
              }
              value={form.status}
            >
              <option value="candidate">Candidate</option>
              <option value="primary">Primary</option>
              <option value="alternate">Alternate</option>
              <option value="invalid">Invalid</option>
              <option value="left_company">Left company</option>
              <option value="suppressed">Suppressed</option>
            </select>
          </label>
          <label className="field field--wide">
            <span>Notes</span>
            <Textarea
              onChange={(event) => update("notes", event.target.value)}
              rows={3}
              value={form.notes}
            />
          </label>
          <div className="field field--wide">
            <Checkbox
              checked={form.reviewed}
              label="I reviewed this person and their current role"
              onCheckedChange={(value) => update("reviewed", value)}
            />
          </div>
        </div>
        {mutation.error ? (
          <InlineNotice tone="danger">{mutation.error.message}</InlineNotice>
        ) : null}
        <div className="dialog-actions">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={
              mutation.isPending ||
              !form.fullName.trim() ||
              Boolean(
                form.phone &&
                  (!form.phoneConfirmed || !form.phoneSource.trim()),
              ) ||
              Boolean(
                form.email &&
                  ["personal", "generic"].includes(form.emailType) &&
                  (!form.fallbackConfirmed || !form.fallbackReason),
              ) ||
              Boolean(
                form.employmentConfirmed &&
                  (!form.observedTitle.trim() || !form.employmentObservedAt),
              )
            }
            type="submit"
            variant="primary"
          >
            {mutation.isPending ? "Saving…" : contact ? "Save person" : "Add person"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ContactCard({
  company,
  contact,
}: {
  company: CompanyDetail;
  contact: ContactSummary;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["company", company.id] }),
      queryClient.invalidateQueries({ queryKey: ["companies"] }),
      queryClient.invalidateQueries({ queryKey: ["drafts"] }),
    ]);
  const patchMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patchContact(contact.id, body),
    onSuccess: invalidate,
  });
  const verifyMutation = useMutation({
    mutationFn: (provider: "hunter" | "zerobounce") =>
      api.verifyEmail(contact.id, provider),
    onSuccess: invalidate,
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const zeroBounceConfigured = Boolean(
    settings.data?.connections.find((item) => item.key === "ZEROBOUNCE_API_KEY")
      ?.configured && settings.data?.values.secondVerifier === "zerobounce",
  );
  const findMutation = useMutation({
    mutationFn: () => api.findEmail(company.id, contact.id),
    onSuccess: invalidate,
  });
  const draftMutation = useMutation({
    mutationFn: () => api.generateDraft(company.id, contact.id),
    onSuccess: async (draft) => {
      await queryClient.invalidateQueries({ queryKey: ["drafts"] });
      navigate(`/outreach/${draft.id}`);
    },
  });
  const error =
    patchMutation.error || verifyMutation.error || findMutation.error || draftMutation.error;

  return (
    <article className={`contact-card ${contact.status === "primary" ? "is-primary" : ""}`}>
      <div className="contact-card__identity">
        <span className="avatar" aria-hidden="true">
          {contact.fullName
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0])
            .join("")
            .toUpperCase()}
        </span>
        <div>
          <div className="contact-name-line">
            <strong>{contact.fullName}</strong>
            {contact.status === "primary" ? <Badge tone="info">Primary</Badge> : null}
            {contact.reviewed ? (
              <Tooltip label="Person reviewed">
                <CheckCircle2 className="verified-mark" size={15} />
              </Tooltip>
            ) : null}
          </div>
          <p>{contact.title || "Role not confirmed"}</p>
          <small>
            {contact.employmentConfirmed && contact.employmentObservedAt
              ? `Employment confirmed ${displayDate(contact.employmentObservedAt)}`
              : "Current employment needs confirmation"}
          </small>
        </div>
        <IconButton label={`Edit ${contact.fullName}`} onClick={() => setEditing(true)}>
          <Pencil size={16} />
        </IconButton>
      </div>
      <div className="contact-card__details">
        <div className="contact-route">
          <Mail size={15} />
          <div>
            {contact.email ? <strong>{contact.email}</strong> : <span>No email found</span>}
            <small>
              {contact.email ? `${titleCase(contact.emailType)} email` : "Hunter can search by name"}
              {contact.emailVerifiedAt
                ? ` · verified ${displayDate(contact.emailVerifiedAt)}`
                : ""}
            </small>
          </div>
          {contact.email ? (
            <Badge tone={emailTone(contact.emailStatus)}>
              {titleCase(contact.emailStatus)}
            </Badge>
          ) : null}
        </div>
          {safeExternalHref(contact.linkedinUrl) ? (
            <a
              className="contact-linkedin"
              href={safeExternalHref(contact.linkedinUrl) as string}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink size={14} />
            Confirm profile manually
          </a>
        ) : null}
        {contact.phone ? (
          <div className="contact-phone">
            <span>{contact.phone}</span>
            <small>
              {titleCase(contact.phoneType)}
              {contact.phoneConfirmed ? " · manually confirmed" : " · unconfirmed"}
            </small>
          </div>
        ) : null}
      </div>
      {contact.notes ? <p className="record-note">{contact.notes}</p> : null}
      {error ? <InlineNotice tone="danger">{error.message}</InlineNotice> : null}
      <div className="contact-card__actions">
        {contact.status !== "primary" ? (
          <Button
            disabled={patchMutation.isPending}
            onClick={() => {
              const currentPrimary = company.contacts.find(
                (item) => item.status === "primary",
              );
              if (
                currentPrimary &&
                !window.confirm(
                  `Make ${contact.fullName} primary and move ${currentPrimary.fullName} to alternate? Outreach history will be retained.`,
                )
              ) {
                return;
              }
              patchMutation.mutate({ status: "primary", rank: 1 });
            }}
            variant="ghost"
          >
            Make primary
          </Button>
        ) : null}
        <Button
          disabled={patchMutation.isPending || contact.rank <= 1}
          onClick={() =>
            patchMutation.mutate({ rank: Math.max(1, contact.rank - 1) })
          }
          variant="ghost"
        >
          Move up
        </Button>
        {contact.status === "primary" ? (
          <Button
            disabled={patchMutation.isPending}
            onClick={() => patchMutation.mutate({ status: "alternate" })}
            variant="ghost"
          >
            Mark alternate
          </Button>
        ) : null}
        {!["left_company", "suppressed", "invalid"].includes(contact.status) ? (
          <Button
            disabled={patchMutation.isPending}
            onClick={() =>
              patchMutation.mutate({
                status: "left_company",
                reviewed: true,
                notes: contact.notes || "No longer at company.",
              })
            }
            variant="ghost"
          >
            Left company
          </Button>
        ) : null}
        {!contact.email ? (
          <Button disabled={findMutation.isPending} onClick={() => findMutation.mutate()}>
            {findMutation.isPending ? "Finding…" : "Find work email"}
          </Button>
        ) : (
          <Button
            disabled={verifyMutation.isPending}
            onClick={() => verifyMutation.mutate("hunter")}
          >
            <ShieldCheck size={15} />
            {verifyMutation.isPending ? "Verifying…" : "Verify email"}
          </Button>
        )}
        {contact.email && zeroBounceConfigured ? (
          <Button
            disabled={verifyMutation.isPending}
            onClick={() => verifyMutation.mutate("zerobounce")}
            variant="ghost"
          >
            Second check
          </Button>
        ) : null}
        <Button
          disabled={
            draftMutation.isPending ||
            contact.status !== "primary" ||
            !contact.email ||
            ["invalid", "disposable", "do_not_mail"].includes(contact.emailStatus)
          }
          onClick={() => draftMutation.mutate()}
          variant="primary"
        >
          <MessageSquareText size={15} />
          {contact.status === "primary" ? "Draft outreach" : "Make primary first"}
        </Button>
      </div>
      <ContactEditor
        companyId={company.id}
        companyName={company.name}
        contact={contact}
        onOpenChange={setEditing}
        open={editing}
      />
    </article>
  );
}

function ManualJobDialog({
  company,
  open,
  onOpenChange,
}: {
  company: CompanyDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [department, setDepartment] = useState("");
  const [url, setUrl] = useState("");
  const [postedAt, setPostedAt] = useState("");
  const [observedAt, setObservedAt] = useState(localDateValue);
  const [excerpt, setExcerpt] = useState("");
  const [noPublicUrl, setNoPublicUrl] = useState(false);
  const [confirmedLive, setConfirmedLive] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      api.addManualJob(company.id, {
        title,
        location: location || null,
        department: department || null,
        url: url || null,
        postedAt: postedAt || null,
        observedAt,
        excerpt: excerpt || null,
        noPublicUrl,
        confirmedLive,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["company", company.id] }),
        queryClient.invalidateQueries({ queryKey: ["companies"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      setTitle("");
      setLocation("");
      setDepartment("");
      setUrl("");
      setPostedAt("");
      setExcerpt("");
      setNoPublicUrl(false);
      setConfirmedLive(false);
      onOpenChange(false);
    },
  });
  useEffect(() => {
    setTitle("");
    setLocation("");
    setDepartment("");
    setUrl("");
    setPostedAt("");
    setObservedAt(localDateValue());
    setExcerpt("");
    setNoPublicUrl(false);
    setConfirmedLive(false);
    mutation.reset();
  }, [company.id, open]);

  return (
    <Dialog
      description="Use a public source when possible. A manually confirmed role is retained as hiring evidence."
      onOpenChange={onOpenChange}
      open={open}
      title="Add live job"
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <div className="form-grid">
          <label className="field field--wide">
            <span>Job title</span>
            <Input
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
              required
              value={title}
            />
          </label>
          <label className="field">
            <span>Location</span>
            <Input
              onChange={(event) => setLocation(event.target.value)}
              value={location}
            />
          </label>
          <label className="field">
            <span>Department</span>
            <Input
              onChange={(event) => setDepartment(event.target.value)}
              value={department}
            />
          </label>
          <label className="field field--wide">
            <span>Public job or hiring URL</span>
            <Input
              disabled={noPublicUrl}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://"
              type="url"
              value={url}
            />
          </label>
          <div className="field field--wide">
            <Checkbox
              checked={noPublicUrl}
              label="No public URL is available"
              onCheckedChange={(value) => {
                setNoPublicUrl(value);
                if (value) setUrl("");
              }}
            />
          </div>
          <label className="field">
            <span>Posted date</span>
            <Input
              max={localDateValue()}
              onChange={(event) => setPostedAt(event.target.value)}
              type="date"
              value={postedAt}
            />
          </label>
          <label className="field">
            <span>Observed date</span>
            <Input
              max={localDateValue()}
              onChange={(event) => setObservedAt(event.target.value)}
              required
              type="date"
              value={observedAt}
            />
          </label>
          <label className="field field--wide">
            <span>Evidence excerpt or note</span>
            <Textarea
              onChange={(event) => setExcerpt(event.target.value)}
              rows={3}
              value={excerpt}
            />
          </label>
          <div className="field field--wide">
            <Checkbox
              checked={confirmedLive}
              label="I confirmed this source says the company is currently hiring"
              onCheckedChange={setConfirmedLive}
            />
          </div>
        </div>
        {mutation.error ? (
          <InlineNotice tone="danger">{mutation.error.message}</InlineNotice>
        ) : null}
        <div className="dialog-actions">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={
              mutation.isPending ||
              !title.trim() ||
              !observedAt ||
              (!url && !noPublicUrl) ||
              !confirmedLive
            }
            type="submit"
            variant="primary"
          >
            {mutation.isPending ? "Saving…" : "Save live job"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const exclusionReasons = [
  ["outside_bay_area", "Outside Bay Area"],
  ["outside_size_range", "Outside size range"],
  ["not_technology_startup", "Not a technology startup"],
  ["not_hiring", "No current hiring"],
  ["large_internal_recruiting", "Large internal recruiting function"],
  ["agencies_not_accepted", "Agencies not accepted"],
  ["mission_outside_scope", "Public mission/category outside scope"],
  ["duplicate", "Duplicate"],
  ["other", "Other"],
] as const;

function ExcludeCompanyDialog({
  company,
  open,
  onOpenChange,
}: {
  company: CompanyDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] =
    useState<(typeof exclusionReasons)[number][0]>("not_hiring");
  const [note, setNote] = useState("");
  const mutation = useMutation({
    mutationFn: () => api.excludeCompany(company.id, { reason, note: note || undefined }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["company", company.id] }),
        queryClient.invalidateQueries({ queryKey: ["companies"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      onOpenChange(false);
    },
  });
  useEffect(() => {
    setReason("not_hiring");
    setNote("");
    mutation.reset();
  }, [company.id, open]);

  return (
    <Dialog
      description="The company remains in SQLite with evidence, people, jobs, and review history."
      onOpenChange={onOpenChange}
      open={open}
      title={`Exclude ${company.name}`}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <label className="field">
          <span>Reason</span>
          <select
            className="select"
            onChange={(event) =>
              setReason(event.target.value as typeof reason)
            }
            value={reason}
          >
            {exclusionReasons.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{reason === "other" ? "Required note" : "Note"}</span>
          <Textarea
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            value={note}
          />
        </label>
        {mutation.error ? (
          <InlineNotice tone="danger">{mutation.error.message}</InlineNotice>
        ) : null}
        <div className="dialog-actions">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={mutation.isPending || (reason === "other" && !note.trim())}
            type="submit"
            variant="danger"
          >
            <Ban size={15} />
            Exclude company
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ConflictResolver({
  company,
}: {
  company: CompanyDetail;
}) {
  const queryClient = useQueryClient();
  const [choices, setChoices] = useState<
    Record<string, "use_candidate" | "keep_current" | "research_further">
  >({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: (conflictId: string) =>
      api.resolveConflict(conflictId, {
        resolution: choices[conflictId] || "research_further",
        note: notes[conflictId] || "",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["company", company.id] }),
        queryClient.invalidateQueries({ queryKey: ["companies"] }),
      ]);
    },
  });
  const unresolved = company.conflicts.filter(
    (conflict) => conflict.status !== "resolved",
  );
  if (!unresolved.length) return null;
  return (
    <div className="conflict-list">
      {unresolved.map((conflict) => {
        const choice = choices[conflict.id] || "research_further";
        return (
          <article className="conflict-card" key={conflict.id}>
            <div>
              <strong>{titleCase(conflict.fieldName)} conflict</strong>
              <p>Choose the supported canonical value or keep researching.</p>
            </div>
            <div className="conflict-options">
              <label>
                <input
                  checked={choice === "keep_current"}
                  name={`conflict-${conflict.id}`}
                  onChange={() =>
                    setChoices((current) => ({
                      ...current,
                      [conflict.id]: "keep_current",
                    }))
                  }
                  type="radio"
                />
                <span>
                  <small>Current</small>
                  <strong>{conflict.currentValue || "Blank"}</strong>
                </span>
              </label>
              <label>
                <input
                  checked={choice === "use_candidate"}
                  disabled={conflict.fieldName === "identity"}
                  name={`conflict-${conflict.id}`}
                  onChange={() =>
                    setChoices((current) => ({
                      ...current,
                      [conflict.id]: "use_candidate",
                    }))
                  }
                  type="radio"
                />
                <span>
                  <small>
                    {conflict.fieldName === "identity"
                      ? "Potential duplicate"
                      : "Candidate evidence"}
                  </small>
                  <strong>{conflict.candidateValue || "Blank"}</strong>
                </span>
              </label>
              <label>
                <input
                  checked={choice === "research_further"}
                  name={`conflict-${conflict.id}`}
                  onChange={() =>
                    setChoices((current) => ({
                      ...current,
                      [conflict.id]: "research_further",
                    }))
                  }
                  type="radio"
                />
                <span>
                  <small>Decision</small>
                  <strong>Research further</strong>
                </span>
              </label>
            </div>
            <label className="field">
              <span>Resolution note</span>
              <Textarea
                onChange={(event) =>
                  setNotes((current) => ({
                    ...current,
                    [conflict.id]: event.target.value,
                  }))
                }
                rows={2}
                value={notes[conflict.id] || ""}
              />
            </label>
            {mutation.error && mutation.variables === conflict.id ? (
              <InlineNotice tone="danger">{mutation.error.message}</InlineNotice>
            ) : null}
            <Button
              disabled={
                mutation.isPending || !notes[conflict.id]?.trim()
              }
              onClick={() => mutation.mutate(conflict.id)}
              variant={choice === "research_further" ? "secondary" : "primary"}
            >
              {mutation.isPending && mutation.variables === conflict.id
                ? "Saving…"
                : choice === "research_further"
                  ? "Keep open"
                  : "Resolve conflict"}
            </Button>
          </article>
        );
      })}
    </div>
  );
}

function ManualEvidenceDialog({
  company,
  open,
  onOpenChange,
}: {
  company: CompanyDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [entityId, setEntityId] = useState(company.id);
  const [fieldName, setFieldName] = useState("general");
  const [value, setValue] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const contactIds = new Set(company.contacts.map((contact) => contact.id));
  const mutation = useMutation({
    mutationFn: () =>
      api.addEvidence({
        entityType: contactIds.has(entityId) ? "contact" : "company",
        entityId,
        fieldName,
        value: value || null,
        sourceUrl: sourceUrl || null,
        excerpt: excerpt || null,
        confirmed,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      setValue("");
      setSourceUrl("");
      setExcerpt("");
      setConfirmed(false);
      onOpenChange(false);
    },
  });
  useEffect(() => {
    setEntityId(company.id);
    setFieldName("general");
    setValue("");
    setSourceUrl("");
    setExcerpt("");
    setConfirmed(false);
    mutation.reset();
  }, [company.id, open]);

  return (
    <Dialog
      description="Attach a source to a fact so it can be rechecked later."
      onOpenChange={onOpenChange}
      open={open}
      title="Add research evidence"
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <div className="form-grid">
          <label className="field">
            <span>Record</span>
            <select
              className="select"
              onChange={(event) => setEntityId(event.target.value)}
              value={entityId}
            >
              <option value={company.id}>{company.name}</option>
              {company.contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.fullName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Fact</span>
            <select
              className="select"
              onChange={(event) => setFieldName(event.target.value)}
              value={fieldName}
            >
              <option value="general">General</option>
              <option value="current_role">Current role</option>
              <option value="email">Email</option>
              <option value="phone">Phone</option>
              <option value="employee_count">Employee count</option>
              <option value="hiring">Hiring need</option>
              <option value="location">Location</option>
            </select>
          </label>
          <label className="field field--wide">
            <span>Observed value</span>
            <Input onChange={(event) => setValue(event.target.value)} value={value} />
          </label>
          <label className="field field--wide">
            <span>Source URL</span>
            <Input
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="https://"
              type="url"
              value={sourceUrl}
            />
          </label>
          <label className="field field--wide">
            <span>Short excerpt or note</span>
            <Textarea
              onChange={(event) => setExcerpt(event.target.value)}
              rows={3}
              value={excerpt}
            />
          </label>
          <div className="field field--wide">
            <Checkbox
              checked={confirmed}
              label="I checked this source and confirmed the fact"
              onCheckedChange={setConfirmed}
            />
          </div>
        </div>
        {mutation.error ? (
          <InlineNotice tone="danger">{mutation.error.message}</InlineNotice>
        ) : null}
        <div className="dialog-actions">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={
              mutation.isPending ||
              !fieldName ||
              !confirmed ||
              !(value.trim() || excerpt.trim())
            }
            type="submit"
            variant="primary"
          >
            Add evidence
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EvidenceRow({ evidence }: { evidence: EvidenceItem }) {
  return (
    <article className="evidence-row">
      <div className="evidence-row__mark">
        {evidence.confidence >= 0.8 ? (
          <CheckCircle2 size={17} />
        ) : (
          <CircleAlert size={17} />
        )}
      </div>
      <div className="evidence-row__body">
        <div className="evidence-row__heading">
          <strong>{titleCase(evidence.fieldName)}</strong>
          <Badge tone={evidence.confidence >= 0.8 ? "success" : "warning"}>
            {Math.round(evidence.confidence * 100)}% confidence
          </Badge>
        </div>
        {evidence.value ? <p className="evidence-value">{evidence.value}</p> : null}
        {evidence.excerpt ? <p>{evidence.excerpt}</p> : null}
        <div className="evidence-row__meta">
          <span>{evidence.sourceLabel}</span>
          <span>Captured {displayDate(evidence.capturedAt)}</span>
          {safeExternalHref(evidence.sourceUrl) ? (
            <a
              href={safeExternalHref(evidence.sourceUrl) as string}
              rel="noreferrer"
              target="_blank"
            >
              Open source <ArrowUpRight size={12} />
            </a>
          ) : null}
          {evidence.screenshotPath ? (
            <a
              href={`/api/evidence/${encodeURIComponent(evidence.id)}/snapshot`}
              rel="noreferrer"
              target="_blank"
            >
              View saved snapshot <ArrowUpRight size={12} />
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function ReviewDecisionBar({
  company,
  onComplete,
}: {
  company: CompanyDetail;
  onComplete: () => void;
}) {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    setNotes("");
    setExpanded(false);
    setConfirmed(false);
  }, [company.id]);
  const mutation = useMutation({
    mutationFn: (decision: "approved" | "rejected" | "needs_research") =>
      api.review(company.id, { decision, notes: notes || undefined }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["companies"] }),
        queryClient.invalidateQueries({ queryKey: ["company", company.id] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      onComplete();
    },
  });

  function submit(decision: "approved" | "rejected" | "needs_research") {
    if (decision !== "approved" && !notes.trim()) {
      setExpanded(true);
      return;
    }
    mutation.mutate(decision);
  }

  return (
    <div className="decision-bar">
      {expanded ? (
        <label className="decision-bar__notes">
          <span>Review notes</span>
          <Textarea
            autoFocus
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Why this is approved, rejected, or needs more research…"
            rows={2}
            value={notes}
          />
        </label>
      ) : null}
      {mutation.error ? (
        <InlineNotice tone="danger">{mutation.error.message}</InlineNotice>
      ) : null}
      <div className="decision-bar__row">
        <div>
          <strong>{company.reviewed ? "Review this record again" : "Complete review"}</strong>
          <span>Decision and notes are retained in history.</span>
        </div>
        <div className="decision-actions">
          <Checkbox
            checked={confirmed}
            label="Reviewed"
            onCheckedChange={setConfirmed}
          />
          <IconButton
            label={expanded ? "Hide review notes" : "Add review notes"}
            onClick={() => setExpanded((value) => !value)}
          >
            <MoreHorizontal size={18} />
          </IconButton>
          <Button
            disabled={mutation.isPending || !confirmed}
            onClick={() => submit("rejected")}
            variant="ghost"
          >
            <X size={15} />
            Reject
          </Button>
          <Button
            disabled={mutation.isPending || !confirmed}
            onClick={() => submit("needs_research")}
          >
            <RefreshCw size={15} />
            Needs research
          </Button>
          <Button
            disabled={mutation.isPending || !confirmed}
            onClick={() => submit("approved")}
            variant="primary"
          >
            <Check size={16} />
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="workspace-section">
      <div className="workspace-section__heading">
        <div>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function CompanyWorkspace({
  company,
  nextId,
  queueQuery,
}: {
  company: CompanyDetail;
  nextId?: string;
  queueQuery: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [editingCompany, setEditingCompany] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const [addingEvidence, setAddingEvidence] = useState(false);
  const [addingJob, setAddingJob] = useState(false);
  const [excludingCompany, setExcludingCompany] = useState(false);
  const tabRefs = useRef<Partial<Record<WorkspaceTab, HTMLButtonElement | null>>>(
    {},
  );

  useEffect(() => setTab("overview"), [company.id]);

  function handleTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: WorkspaceTab,
  ) {
    const currentIndex = reviewTabs.findIndex(({ value }) => value === currentTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % reviewTabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + reviewTabs.length) % reviewTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = reviewTabs.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = reviewTabs[nextIndex].value;
    setTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["company", company.id] }),
      queryClient.invalidateQueries({ queryKey: ["companies"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    ]);
  const websiteMutation = useMutation({
    mutationFn: () => api.researchWebsite(company.id),
    onSuccess: invalidate,
  });
  const apolloMutation = useMutation({
    mutationFn: () => api.researchApollo(company.id),
    onSuccess: invalidate,
  });
  const domainMutation = useMutation({
    mutationFn: () => api.researchDomain(company.id, true),
    onSuccess: invalidate,
  });
  const researchError =
    websiteMutation.error || apolloMutation.error || domainMutation.error;

  return (
    <div className="company-workspace">
      <header className="record-header">
        <Link
          className="mobile-back-link"
          to={`/review${queueQuery ? `?${queueQuery}` : ""}`}
        >
          <ArrowLeft size={15} />
          Queue
        </Link>
        <div className="record-header__main">
          <div className="record-heading">
            <div className="company-monogram" aria-hidden="true">
              {company.name.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="record-title-row">
                <h2>{company.name}</h2>
                <Badge
                  tone={
                    company.status === "approved"
                      ? "success"
                      : company.status === "rejected"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {titleCase(company.status)}
                </Badge>
                {company.priority === "high" ? <Badge tone="warning">High priority</Badge> : null}
              </div>
              <div className="record-subtitle">
                <span>
                  <MapPin size={13} />
                  {company.location || "Location unconfirmed"}
                </span>
                <span>
                  <UsersRound size={13} />
                  {companySize(company)}
                </span>
                {company.stage ? <span>{company.stage}</span> : null}
              </div>
            </div>
          </div>
          <div className="record-header__actions">
            <Button onClick={() => setEditingCompany(true)}>
              <Pencil size={15} />
              Edit
            </Button>
            <Button onClick={() => setExcludingCompany(true)} variant="ghost">
              <Ban size={15} />
              Exclude
            </Button>
            <Button
              disabled={websiteMutation.isPending}
              onClick={() => websiteMutation.mutate()}
            >
              <Globe2 size={15} />
              {websiteMutation.isPending ? "Researching…" : "Research website"}
            </Button>
            {!company.domain ? (
              <Button
                disabled={domainMutation.isPending}
                onClick={() => domainMutation.mutate()}
              >
                <Search size={15} />
                {domainMutation.isPending ? "Resolving…" : "Find domain"}
              </Button>
            ) : null}
            <Button
              disabled={apolloMutation.isPending}
              onClick={() => apolloMutation.mutate()}
              variant="primary"
            >
              <Sparkles size={15} />
              {apolloMutation.isPending ? "Enriching…" : "Enrich people"}
            </Button>
          </div>
        </div>
        <SourceLinks company={company} />
        {researchError ? (
          <InlineNotice tone="danger">{researchError.message}</InlineNotice>
        ) : null}
      </header>

      <div
        aria-label="Company record sections"
        className="workspace-tabs"
        role="tablist"
      >
        {reviewTabs.map(({ value, label, icon: Icon }) => (
          <button
            aria-controls="company-record-panel"
            aria-selected={tab === value}
            className={tab === value ? "is-active" : ""}
            id={`company-tab-${value}`}
            key={value}
            onClick={() => setTab(value)}
            onKeyDown={(event) => handleTabKeyDown(event, value)}
            ref={(element) => {
              tabRefs.current[value] = element;
            }}
            role="tab"
            tabIndex={tab === value ? 0 : -1}
            type="button"
          >
            <Icon aria-hidden="true" size={15} />
            {label}
            {value === "people" ? <span>{company.contacts.length}</span> : null}
            {value === "evidence" ? <span>{company.evidence.length}</span> : null}
          </button>
        ))}
      </div>

      <div
        aria-labelledby={`company-tab-${tab}`}
        className="workspace-scroll"
        id="company-record-panel"
        role="tabpanel"
        tabIndex={0}
      >
        {tab === "overview" ? (
          <>
            <section className="signal-summary">
              <div>
                <span className="signal-summary__score">{company.hiringScore}</span>
                <div>
                  <strong>{scoreLabel(company.hiringScore)}</strong>
                  <p>
                    {company.freshRolesCount} recently seen · {company.openRolesCount} open
                    role{company.openRolesCount === 1 ? "" : "s"}
                  </p>
                </div>
              </div>
              <div className="signal-summary__facts">
                <span>
                  <Clock3 size={14} />
                  Researched {displayDate(company.lastResearchedAt)}
                </span>
                <span>
                  <FileCheck2 size={14} />
                  {company.evidence.length} evidence items
                </span>
                {company.conflictCount ? (
                  <span className="has-conflict">
                    <CircleAlert size={14} />
                    {company.conflictCount} conflict{company.conflictCount === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
              <div className="score-breakdown" aria-label="Hiring score breakdown">
                {[
                  ["Live hiring", company.hiringScoreBreakdown.liveHiring, 40],
                  ["Freshness", company.hiringScoreBreakdown.freshness, 20],
                  ["Company fit", company.hiringScoreBreakdown.companyFit, 15],
                  [
                    "Outside-help fit",
                    company.hiringScoreBreakdown.externalHelpFit,
                    15,
                  ],
                  [
                    "Evidence",
                    company.hiringScoreBreakdown.evidenceQuality,
                    10,
                  ],
                ].map(([label, value, maximum]) => (
                  <span key={String(label)}>
                    {label} {value}/{maximum}
                  </span>
                ))}
              </div>
            </section>
            <section className="readiness-strip" aria-label="Record readiness">
              {company.readiness.map((item) => (
                <button
                  className={`readiness-strip__item is-${item.state}`}
                  key={item.id}
                  onClick={() =>
                    setTab(
                      ["decision_maker", "contact_route", "email_current"].includes(
                        item.id,
                      )
                        ? "people"
                        : item.id === "conflicts"
                          ? "evidence"
                          : "overview",
                    )
                  }
                  title={item.detail}
                  type="button"
                >
                  {item.state === "complete" ? (
                    <CheckCircle2 size={15} />
                  ) : (
                    <CircleAlert size={15} />
                  )}
                  <span>
                    <strong>{item.label}</strong>
                    <small>
                      {item.state === "complete"
                        ? "Complete"
                        : item.state === "blocked"
                          ? "Blocked"
                          : "Needs attention"}
                    </small>
                  </span>
                </button>
              ))}
            </section>
            <WorkspaceSection title="Company brief">
              <div className="company-brief">
                <p>
                  {company.description ||
                    "No description has been captured. Research the public website or add a concise company summary."}
                </p>
                <dl className="fact-grid">
                  <div>
                    <dt>Industry</dt>
                    <dd>{company.industries.join(", ") || "Unclassified"}</dd>
                  </div>
                  <div>
                    <dt>Stage</dt>
                    <dd>{company.stage || "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Domain</dt>
                    <dd>{company.domain || "Unconfirmed"}</dd>
                  </div>
                  <div>
                    <dt>Sources</dt>
                    <dd>{company.sourceLabels.join(", ") || "Manual"}</dd>
                  </div>
                </dl>
                {company.notes ? (
                  <div className="internal-note">
                    <strong>Internal notes</strong>
                    <p>{company.notes}</p>
                  </div>
                ) : null}
              </div>
            </WorkspaceSection>
            <WorkspaceSection
              action={
                <Button onClick={() => setAddingJob(true)}>
                  <Plus size={15} />
                  Add live job
                </Button>
              }
              description="Published roles are the strongest immediate-need signal."
              title="Hiring now"
            >
              {company.jobs.length ? (
                <div className="jobs-list">
                  {company.jobs.map((job) => (
                    <article className={`job-row ${job.active ? "" : "is-inactive"}`} key={job.id}>
                      <span className="job-row__icon">
                        <BriefcaseBusiness size={16} />
                      </span>
                      <div>
                        <strong>{job.title}</strong>
                        <p>
                          {[job.department, job.location].filter(Boolean).join(" · ") ||
                            "Department and location not listed"}
                        </p>
                      </div>
                      <div className="job-row__meta">
                        <Badge tone={job.active ? "success" : "neutral"}>
                          {job.active ? "Open" : "Inactive"}
                        </Badge>
                        <span>{displayDate(job.postedAt || job.firstSeenAt)}</span>
                        {safeExternalHref(job.url) ? (
                          <a
                            aria-label={`Open ${job.title}`}
                            href={safeExternalHref(job.url) as string}
                            rel="noreferrer"
                            target="_blank"
                          >
                            <ArrowUpRight size={15} />
                          </a>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState
                  body="Research the company website or add a public job board from Discover."
                  title="No open roles captured"
                />
              )}
            </WorkspaceSection>
          </>
        ) : null}

        {tab === "people" ? (
          <WorkspaceSection
            action={
              <Button onClick={() => setAddingContact(true)}>
                <Plus size={15} />
                Add person
              </Button>
            }
            description="Contact one decision-maker at a time; rank alternates for later rounds."
            title="Decision-makers"
          >
            {company.contacts.length ? (
              <div className="contact-list">
                {company.contacts.map((contact) => (
                  <ContactCard company={company} contact={contact} key={contact.id} />
                ))}
              </div>
            ) : (
              <EmptyState
                action={
                  <Button onClick={() => setAddingContact(true)} variant="primary">
                    Add decision-maker
                  </Button>
                }
                body="Add a founder, operations leader, or recruiting owner, then confirm their current role."
                title="No people yet"
              />
            )}
          </WorkspaceSection>
        ) : null}

        {tab === "evidence" ? (
          <WorkspaceSection
            action={
              <Button onClick={() => setAddingEvidence(true)}>
                <Plus size={15} />
                Add evidence
              </Button>
            }
            description="The newest source appears first. Open the original before resolving a conflict."
            title="Source trail"
          >
            {company.conflictCount ? (
              <InlineNotice tone="warning">
                This record has {company.conflictCount} field conflict
                {company.conflictCount === 1 ? "" : "s"}. Research further and keep the
                most current supported value.
              </InlineNotice>
            ) : null}
            <ConflictResolver company={company} />
            {company.evidence.length ? (
              <div className="evidence-list">
                {company.evidence.map((evidence) => (
                  <EvidenceRow evidence={evidence} key={evidence.id} />
                ))}
              </div>
            ) : (
              <EmptyState
                action={<Button onClick={() => setAddingEvidence(true)}>Add evidence</Button>}
                body="Research sources and manual confirmations will appear here."
                title="No evidence recorded"
              />
            )}
          </WorkspaceSection>
        ) : null}

        {tab === "history" ? (
          <WorkspaceSection
            description="Every material edit and review decision is retained."
            title="Record history"
          >
            {company.audit.length ? (
              <ol className="timeline">
                {company.audit.map((event) => (
                  <li key={event.id}>
                    <span className="timeline__mark" aria-hidden="true" />
                    <div>
                      <strong>{event.summary}</strong>
                      <p>
                        {titleCase(event.eventType)} · {displayDate(event.createdAt, true)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState body="Changes to this record will be logged here." title="No history yet" />
            )}
          </WorkspaceSection>
        ) : null}
      </div>

      <ReviewDecisionBar
        company={company}
        onComplete={() => {
          if (nextId) {
            navigate(
              `/review/${nextId}${queueQuery ? `?${queueQuery}` : ""}`,
            );
          }
        }}
      />

      <CompanyEditor
        company={company}
        onOpenChange={setEditingCompany}
        open={editingCompany}
      />
      <ContactEditor
        companyId={company.id}
        companyName={company.name}
        onOpenChange={setAddingContact}
        open={addingContact}
      />
      <ManualEvidenceDialog
        company={company}
        onOpenChange={setAddingEvidence}
        open={addingEvidence}
      />
      <ManualJobDialog
        company={company}
        onOpenChange={setAddingJob}
        open={addingJob}
      />
      <ExcludeCompanyDialog
        company={company}
        onOpenChange={setExcludingCompany}
        open={excludingCompany}
      />
    </div>
  );
}

export function ReviewPage() {
  const { companyId } = useParams();
  const navigate = useNavigate();
  const [urlParams, setUrlParams] = useSearchParams();
  const search = urlParams.get("q") || "";
  const requestedView = urlParams.get("view");
  const view: ReviewView = [
    "unreviewed",
    "all",
    "approved",
    "needs_research",
  ].includes(requestedView || "")
    ? (requestedView as ReviewView)
    : "unreviewed";
  const openRolesOnly = urlParams.get("hiring") !== "false";
  const requestedNeeds = urlParams.get("needs");
  const needs = [
    "any",
    "fresh_jobs",
    "missing_decision_maker",
    "missing_email",
    "email_verification",
    "conflicts",
    "ready_final",
  ].includes(requestedNeeds || "")
    ? (requestedNeeds as string)
    : "any";
  const requestedPriority = urlParams.get("priority");
  const priority = ["all", "high", "medium", "low"].includes(
    requestedPriority || "",
  )
    ? (requestedPriority as string)
    : "all";
  const requestedSort = urlParams.get("sort");
  const sort = ["hiring", "recent", "roles", "name", "oldest"].includes(
    requestedSort || "",
  )
    ? (requestedSort as string)
    : "hiring";
  const requestedPage = Number(urlParams.get("page"));
  const page =
    Number.isInteger(requestedPage) && requestedPage >= 0 ? requestedPage : 0;
  const pageSize = 100;

  function commitQueueParams(next: URLSearchParams) {
    const query = next.toString();
    if (companyId) {
      navigate(`/review${query ? `?${query}` : ""}`);
    } else {
      setUrlParams(next);
    }
  }

  function updateQueueParam(
    key: string,
    value: string,
    defaultValue: string,
  ) {
    const next = new URLSearchParams(urlParams);
    if (value === defaultValue || !value) next.delete(key);
    else next.set(key, value);
    next.delete("page");
    commitQueueParams(next);
  }

  const setSearch = (value: string) => updateQueueParam("q", value, "");
  const setView = (value: ReviewView) =>
    updateQueueParam("view", value, "unreviewed");
  const setOpenRolesOnly = (value: boolean) =>
    updateQueueParam("hiring", value ? "true" : "false", "true");
  const setNeeds = (value: string) => updateQueueParam("needs", value, "any");
  const setPriority = (value: string) =>
    updateQueueParam("priority", value, "all");
  const setSort = (value: string) =>
    updateQueueParam("sort", value, "hiring");
  const setPage = (action: number | ((current: number) => number)) => {
    const nextPage = typeof action === "function" ? action(page) : action;
    const next = new URLSearchParams(urlParams);
    if (nextPage > 0) next.set("page", String(nextPage));
    else next.delete("page");
    commitQueueParams(next);
  };

  const params = useMemo(() => {
    const value = new URLSearchParams({
      limit: String(pageSize),
      offset: String(page * pageSize),
    });
    if (search.trim()) value.set("search", search.trim());
    if (view === "unreviewed") value.set("reviewed", "false");
    if (view === "approved") value.set("status", "approved");
    if (view === "needs_research") value.set("status", "needs_research");
    if (openRolesOnly) value.set("hasOpenRoles", "true");
    if (needs !== "any") value.set("needs", needs);
    if (priority !== "all") value.set("priority", priority);
    value.set("sort", sort);
    return value;
  }, [needs, openRolesOnly, page, priority, search, sort, view]);

  const companies = useQuery({
    queryKey: ["companies", params.toString()],
    queryFn: () => api.companies(params),
  });
  const selectedId = companyId || companies.data?.data[0]?.id;
  const company = useQuery({
    enabled: Boolean(selectedId),
    queryKey: ["company", selectedId],
    queryFn: () => api.company(selectedId as string),
  });
  const currentIndex =
    companies.data?.data.findIndex((item) => item.id === selectedId) ?? -1;
  const nextId =
    currentIndex >= 0 ? companies.data?.data[currentIndex + 1]?.id : undefined;
  const previousId =
    currentIndex > 0 ? companies.data?.data[currentIndex - 1]?.id : undefined;
  const queueQuery = urlParams.toString();

  useEffect(() => {
    if (!companyId || !companies.data) return;
    if (companies.data.data.some((item) => item.id === companyId)) return;
    const fallbackId = companies.data.data[0]?.id;
    navigate(
      `${fallbackId ? `/review/${fallbackId}` : "/review"}${
        queueQuery ? `?${queueQuery}` : ""
      }`,
      { replace: true },
    );
  }, [companies.data, companyId, navigate, queueQuery]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches(
          "input, textarea, select, button, a, [contenteditable='true']",
        ) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const destination =
        event.key.toLowerCase() === "j"
          ? nextId
          : event.key.toLowerCase() === "k"
            ? previousId
            : null;
      if (!destination) return;
      event.preventDefault();
      navigate(
        `/review/${destination}${queueQuery ? `?${queueQuery}` : ""}`,
      );
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, nextId, previousId, queueQuery]);

  return (
    <div className="page page--review">
      <PageHeader
        actions={
          <a className="button button--secondary" href="/api/export/contacts.csv">
            Export contacts CSV
          </a>
        }
        description="Resolve one company bundle at a time, with hiring evidence beside the decision-maker."
        meta={
          companies.data ? (
            <Badge tone="neutral">{companies.data.meta.total} in view</Badge>
          ) : undefined
        }
        title="Review"
      />

      <div className={`review-layout ${companyId ? "has-selection" : ""}`}>
        <aside className="queue-panel">
          <div className="queue-tools">
            <label className="search-field">
              <Search size={16} aria-hidden="true" />
              <Input
                aria-label="Search companies"
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                placeholder="Search company or sector"
                type="search"
                value={search}
              />
            </label>
            <div className="queue-filter-row">
              <label className="select-label">
                <Filter size={14} />
                <select
                  aria-label="Review view"
                  className="select select--compact"
                  onChange={(event) => {
                    setView(event.target.value as ReviewView);
                  }}
                  value={view}
                >
                  <option value="unreviewed">Unreviewed</option>
                  <option value="needs_research">Needs research</option>
                  <option value="approved">Approved</option>
                  <option value="all">All companies</option>
                </select>
              </label>
              <Checkbox
                checked={openRolesOnly}
                label="Hiring only"
                onCheckedChange={(checked) => {
                  setOpenRolesOnly(checked);
                }}
              />
            </div>
            <div className="queue-filter-row queue-filter-row--triple">
              <label className="select-label">
                <select
                  aria-label="Record needs"
                  className="select select--compact"
                  onChange={(event) => setNeeds(event.target.value)}
                  value={needs}
                >
                  <option value="any">Any need</option>
                  <option value="fresh_jobs">Has fresh jobs</option>
                  <option value="missing_decision_maker">
                    Missing decision-maker
                  </option>
                  <option value="missing_email">Missing email</option>
                  <option value="email_verification">
                    Email needs verification
                  </option>
                  <option value="conflicts">Has conflicts</option>
                  <option value="ready_final">Ready for final review</option>
                </select>
              </label>
              <label className="select-label">
                <select
                  aria-label="Priority"
                  className="select select--compact"
                  onChange={(event) => setPriority(event.target.value)}
                  value={priority}
                >
                  <option value="all">Any priority</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
              <label className="select-label">
                <select
                  aria-label="Sort companies"
                  className="select select--compact"
                  onChange={(event) => setSort(event.target.value)}
                  value={sort}
                >
                  <option value="hiring">Best hiring signal</option>
                  <option value="recent">Most recent evidence</option>
                  <option value="roles">Most open roles</option>
                  <option value="name">Company name</option>
                  <option value="oldest">Oldest unreviewed</option>
                </select>
              </label>
            </div>
            {search ||
            view !== "unreviewed" ||
            !openRolesOnly ||
            needs !== "any" ||
            priority !== "all" ||
            sort !== "hiring" ? (
              <Button
                onClick={() => {
                  commitQueueParams(new URLSearchParams());
                }}
                variant="ghost"
              >
                Clear filters
              </Button>
            ) : null}
            <div className="queue-navigation">
              <span>
                {companies.data
                  ? `Showing ${companies.data.data.length} of ${companies.data.meta.total}`
                  : "Loading queue"}
              </span>
              <div>
                <Button
                  aria-label="Previous record (K)"
                  disabled={!previousId}
                  onClick={() =>
                    previousId &&
                    navigate(
                      `/review/${previousId}${queueQuery ? `?${queueQuery}` : ""}`,
                    )
                  }
                  variant="ghost"
                >
                  <ChevronLeft size={14} /> K
                </Button>
                <Button
                  aria-label="Next record (J)"
                  disabled={!nextId}
                  onClick={() =>
                    nextId &&
                    navigate(
                      `/review/${nextId}${queueQuery ? `?${queueQuery}` : ""}`,
                    )
                  }
                  variant="ghost"
                >
                  J <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          </div>
          <div className="queue-list" aria-label="Company review queue">
            {companies.isLoading ? (
              <div className="queue-loading">
                <Spinner label="Loading queue" />
              </div>
            ) : companies.error ? (
              <InlineNotice tone="danger">{companies.error.message}</InlineNotice>
            ) : companies.data?.data.length ? (
              companies.data.data.map((item) => (
                <QueueRow
                  active={item.id === selectedId}
                  company={item}
                  key={item.id}
                  queryString={queueQuery}
                />
              ))
            ) : (
              <EmptyState
                action={
                  <Link className="button button--primary" to="/discover">
                    Discover companies
                  </Link>
                }
                body="Adjust the filters or collect a new source."
                title="Queue is clear"
              />
            )}
          </div>
          {companies.data?.meta.total &&
          companies.data.meta.total > pageSize ? (
            <div className="queue-pagination">
              <Button
                aria-label="Previous company page"
                disabled={page === 0}
                onClick={() => {
                  setPage((current) => Math.max(0, current - 1));
                }}
                variant="ghost"
              >
                <ChevronLeft size={14} />
                Previous
              </Button>
              <span>
                {page * pageSize + 1}–
                {Math.min((page + 1) * pageSize, companies.data.meta.total)} of{" "}
                {companies.data.meta.total}
              </span>
              <Button
                aria-label="Next company page"
                disabled={(page + 1) * pageSize >= companies.data.meta.total}
                onClick={() => {
                  setPage((current) => current + 1);
                }}
                variant="ghost"
              >
                Next
                <ChevronRight size={14} />
              </Button>
            </div>
          ) : null}
        </aside>

        <section className="workspace-panel">
          {company.isLoading ? (
            <div className="workspace-loading">
              <Spinner label="Loading company record" />
            </div>
          ) : company.error ? (
            <div className="workspace-loading">
              <InlineNotice tone="danger">{company.error.message}</InlineNotice>
            </div>
          ) : company.data ? (
            <CompanyWorkspace
              company={company.data}
              nextId={nextId}
              queueQuery={queueQuery}
            />
          ) : (
            <EmptyState
              action={
                <Link className="button button--primary" to="/discover">
                  Start discovery
                </Link>
              }
              body="Choose a record from the queue, or collect companies to begin."
              title="Select a company"
            />
          )}
        </section>
      </div>
    </div>
  );
}
