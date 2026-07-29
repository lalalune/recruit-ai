import { createOrUpdateDraft, getCompany, getSettings } from "./repository";

function firstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

function companyContext(company: NonNullable<ReturnType<typeof getCompany>>) {
  const jobs = company.jobs.filter((job) => job.active);
  if (!jobs.length) return "your current hiring plans";
  if (jobs.length === 1) return `your search for a ${jobs[0].title}`;
  const titles = jobs.slice(0, 2).map((job) => job.title);
  return `${jobs.length} open roles, including ${titles.join(" and ")}`;
}

function specialization(company: NonNullable<ReturnType<typeof getCompany>>) {
  if (!company.industries.length) return "technical and business";
  return company.industries.slice(0, 2).join(" and ");
}

function contactContext(
  contact: NonNullable<ReturnType<typeof getCompany>>["contacts"][number],
  size: "small" | "growing" | "scaling",
) {
  const category = contact.roleCategory || "";
  if (category === "founder") {
    return size === "small"
      ? "I thought it made sense to ask you directly while the team is still founder-led."
      : "I thought you would know who owns the most urgent hiring priorities.";
  }
  if (category === "people" || category === "talent") {
    return "Your people and talent remit made you the most relevant person to ask.";
  }
  if (category === "operations") {
    return "I thought your operations remit likely gives you a clear view of the roles slowing the team down.";
  }
  return contact.title
    ? `Given your role as ${contact.title}, I thought you would know who owns these searches.`
    : "I thought you might be able to point me to the person who owns these searches.";
}

export function generateDraft(
  companyId: string,
  contactId: string,
  tone: "concise" | "technical" | "founder",
) {
  const company = getCompany(companyId);
  if (!company) throw new Error("Company not found.");
  const contact = company.contacts.find((item) => item.id === contactId);
  if (!contact) throw new Error("Contact not found.");
  if (contact.status !== "primary") {
    throw new Error("Make this decision-maker primary before drafting outreach.");
  }
  const size: "small" | "growing" | "scaling" =
    company.employeeCountMax && company.employeeCountMax <= 20
      ? "small"
      : company.employeeCountMax && company.employeeCountMax <= 100
        ? "growing"
        : "scaling";
  const greeting = `Hi ${firstName(contact.fullName)},`;
  const configuredSender = getSettings().sender_name;
  const senderName =
    typeof configuredSender === "string" && configuredSender.trim()
      ? configuredSender.trim()
      : "[Your name]";
  const intro =
    tone === "technical"
      ? `I was looking at ${company.name}'s work in ${specialization(company)} and noticed ${companyContext(company)}.`
      : tone === "founder"
        ? `I know recruiting can pull a ${size} team away from building, and I noticed ${companyContext(company)} at ${company.name}.`
        : `I noticed ${companyContext(company)} at ${company.name}.`;
  const body = [
    greeting,
    "",
    intro,
    contactContext(contact, size),
    "",
    "I run contingency searches for Bay Area technology startups across engineering, research, operations, and leadership. There is no retainer: if you want help, we sign a simple agreement and the fee is 30% of first-year salary only for someone you hire from my introduction.",
    "",
    `Would it be useful if I sent over a few relevant profiles for ${company.jobs[0]?.title || "the roles you are prioritizing"}?`,
    "",
    "Best,",
    senderName,
  ].join("\n");
  return createOrUpdateDraft({
    companyId,
    contactId,
    subject:
      company.jobs.length > 0
        ? `Help with ${company.jobs[0].title} at ${company.name}`
        : `Recruiting help for ${company.name}`,
    body,
  });
}
