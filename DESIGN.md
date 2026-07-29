---
name: RecruitAI
description: "A compact, evidence-first research desk for one-at-a-time recruiting decisions."
colors:
  canvas: "oklch(0.975 0.008 275)"
  surface: "oklch(0.995 0.003 275)"
  surface-subtle: "oklch(0.958 0.009 275)"
  surface-strong: "oklch(0.925 0.014 275)"
  ink: "oklch(0.235 0.025 274)"
  ink-muted: "oklch(0.475 0.025 274)"
  ink-faint: "oklch(0.61 0.022 274)"
  border: "oklch(0.875 0.016 275)"
  border-strong: "oklch(0.77 0.025 275)"
  accent: "oklch(0.5 0.16 280)"
  accent-hover: "oklch(0.44 0.17 280)"
  accent-soft: "oklch(0.945 0.035 280)"
  accent-ink: "oklch(0.39 0.13 280)"
  on-accent: "oklch(1 0 0)"
  success: "oklch(0.49 0.105 154)"
  success-soft: "oklch(0.95 0.035 154)"
  warning: "oklch(0.58 0.12 68)"
  warning-soft: "oklch(0.96 0.045 78)"
  danger: "oklch(0.52 0.17 28)"
  danger-soft: "oklch(0.955 0.035 28)"
  info: "oklch(0.5 0.12 245)"
  info-soft: "oklch(0.95 0.032 245)"
  focus: "oklch(0.64 0.16 280)"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(1.45rem, 2vw, 1.75rem)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  body-compact:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.84rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.81rem"
    fontWeight: 620
    lineHeight: 1.2
    letterSpacing: "normal"
  data-label:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.68rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.04em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
rounded:
  xs: "4px"
  sm: "6px"
  md: "9px"
  lg: "13px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
    height: "36px"
  button-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
    height: "36px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.sm}"
    padding: "7px 10px"
    height: "38px"
    width: "100%"
  badge-neutral:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.data-label}"
    rounded: "{rounded.full}"
    padding: "3px 7px"
    height: "22px"
  badge-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    typography: "{typography.data-label}"
    rounded: "{rounded.full}"
    padding: "3px 7px"
    height: "22px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "20px"
  nav-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
    height: "40px"
---

# Design System: RecruitAI

## Overview

**Creative North Star: "The Focused Research Desk"**

RecruitAI should feel like a well-organized research desk used for hours at a time: light, quiet, compact, and explicit about what needs attention. Cool violet-tinted neutrals separate the fixed navigation, working canvas, queues, and record surfaces without turning every region into a floating card. One restrained violet action color creates a clear path through discovery, review, and outreach.

The interface is a workbench, not a campaign. Lists stay dense enough to scan, then open into one reusable workspace where evidence, people, conflicts, and history can be inspected without losing queue position. Semantic colors communicate state alongside plain-language labels and icons. Motion is brief and functional; automation proposes, while the owner remains visibly in control.

The system explicitly rejects bloated enterprise CRM density, sales-engagement gamification, dark neon “hacker” styling, generic AI gradients, glassmorphism, spreadsheet replicas, novelty controls, and multi-step wizards. Familiar interaction patterns and progressive depth are the design advantage.

**Key Characteristics:**

- Compact queue-and-workspace layouts with one obvious next action.
- Cool near-white tonal layers with violet reserved for action and current context.
- Evidence states expressed through color, icon, label, freshness, and source.
- One sans-serif family, tight hierarchy, and data-friendly labels.
- Local-first and human-reviewed safeguards made visible in the interface.
- Responsive structure that collapses navigation and swaps queue/workspace views without hiding capability.

**The One-Decision Rule.** Every surface must make the next useful decision visually obvious; secondary controls recede until they are needed.

**The Progressive-Depth Rule.** Keep queues compact and reveal full record context in the adjacent workspace or one focused dialog. Never expose every stored field at once.

## Colors

The palette is a restrained family of cool violet-tinted neutrals, one decisive violet accent, and four evidence colors used only for meaningful state.

### Primary

- **Decisive Violet** (`{colors.accent}`): Primary actions, current navigation, selected controls, and the small number of places that move work forward.
- **Pressed Violet** (`{colors.accent-hover}`): Hover and pressed emphasis for primary actions only.
- **Violet Wash** (`{colors.accent-soft}`): Selected control backgrounds, compact icon wells, and low-emphasis action context.
- **Violet Ink** (`{colors.accent-ink}`): Text links and readable violet copy on pale surfaces.
- **Focus Violet** (`{colors.focus}`): The visible keyboard focus outline; it is functional, never decorative.

### Secondary

- **Evidence Green** (`{colors.success}`) and **Evidence Green Wash** (`{colors.success-soft}`): Confirmed, complete, connected, valid, or approved states.
- **Review Amber** (`{colors.warning}`) and **Review Amber Wash** (`{colors.warning-soft}`): Stale, catch-all, incomplete, or needs-attention states.
- **Conflict Red** (`{colors.danger}`) and **Conflict Red Wash** (`{colors.danger-soft}`): Errors, rejected records, blocked states, and destructive actions.
- **Source Blue** (`{colors.info}`) and **Source Blue Wash** (`{colors.info-soft}`): Informational status, signal-only sources, and neutral process feedback.

### Neutral

- **Desk Canvas** (`{colors.canvas}`): The application background behind all working surfaces.
- **Record Surface** (`{colors.surface}`): Primary panels, controls, selected rows, and dialogs.
- **Queue Wash** (`{colors.surface-subtle}`): Sidebars, queue rails, tab rails, and secondary work areas.
- **Pressed Surface** (`{colors.surface-strong}`): Counts, low-emphasis chips, and compact state wells.
- **Graphite Ink** (`{colors.ink}`): Headings, entered values, company names, and primary content.
- **Muted Graphite** (`{colors.ink-muted}`): Explanatory copy and secondary facts that remain necessary to the task.
- **Faint Graphite** (`{colors.ink-faint}`): Timestamps and nonessential metadata only; never placeholders or body instructions.
- **Hairline** (`{colors.border}`) and **Strong Hairline** (`{colors.border-strong}`): Structural separation and interactive control boundaries.
- **On Accent** (`{colors.on-accent}`): Text and icons on saturated violet controls.

**The Ten-Percent Violet Rule.** Decisive Violet occupies no more than roughly 10% of a screen. Its scarcity tells the owner where to act.

**The Evidence-Is-Not-Decoration Rule.** Green, amber, red, and blue appear only when a real record state exists. Always pair them with an icon, label, or both.

**The Readability Rule.** Use Graphite Ink or Muted Graphite for meaningful copy. Faint Graphite is prohibited for placeholders, instructions, and any text the owner must read to complete a task.

## Typography

**Display Font:** Inter, falling back to the native UI sans-serif stack.

**Body Font:** Inter, falling back to the native UI sans-serif stack.

**Label/Mono Font:** Inter for labels; the native SFMono/Menlo/Consolas stack for paths, identifiers, and code.

**Character:** One disciplined sans-serif voice keeps the product precise and familiar. Hierarchy comes from weight, size, spacing, and position rather than a decorative display face.

### Hierarchy

- **Headline** (`{typography.headline}`): Page names only. Keep copy short, balanced, and below two lines.
- **Title** (`{typography.title}`): Dialog titles, record titles, and the strongest local heading.
- **Body** (`{typography.body}`): Explanations and longer reading. Cap prose at 72 characters per line.
- **Compact Body** (`{typography.body-compact}`): Queue metadata, control descriptions, and most dense working copy.
- **Label** (`{typography.label}`): Buttons, field labels, navigation, and actionable row text.
- **Data Label** (`{typography.data-label}`): Table headers and fact labels. Uppercase is reserved for real data axes, never used as a decorative eyebrow.
- **Mono** (`{typography.mono}`): Local paths, API identifiers, and technical values only.

**The One-Voice Rule.** Use one sans-serif family across headings, controls, labels, and data. Never introduce a display font for product UI.

**The Quiet-Metadata Rule.** Metadata may be smaller, but it must remain readable. If a timestamp or source label carries a decision, promote it to Compact Body and Muted Graphite.

## Elevation

RecruitAI is flat by default. Depth comes primarily from adjacent tonal surfaces and hairline separators. The small structural shadow (`0 1px 2px oklch(0.23 0.03 275 / 0.08)`) may reinforce a primary button, selected navigation item, or top-level panel. The overlay shadow (`0 12px 36px oklch(0.23 0.03 275 / 0.14)`) is reserved for a dialog above a dimmed backdrop and must not be paired with a decorative border.

### Shadow Vocabulary

- **Structural Rest** (`0 1px 2px oklch(0.23 0.03 275 / 0.08)`): A barely visible lift for top-level panels, selected navigation, and primary or secondary buttons.
- **Overlay Lift** (`0 12px 36px oklch(0.23 0.03 275 / 0.14)`): Dialogs only, against the overlay scrim.
- **Sticky Separation** (`0 -7px 18px oklch(0.25 0.02 275 / 0.04)`): The review decision bar when it sits above scrolling evidence.
- **Mobile Navigation Lift** (`0 -4px 16px oklch(0.23 0.03 275 / 0.08)`): The fixed bottom navigation at narrow widths.

**The Flat-By-Default Rule.** A resting surface earns either a border or a shadow based on its structural role. Never combine a 1px border with a wide decorative shadow.

**The State-Only Motion Rule.** Use 120–140ms transitions for hover, focus, selection, and dialog entry. Loading rotation is the sole continuous animation. Reduced-motion preferences collapse all movement to an immediate state change.

## Components

### Buttons

- **Character:** Compact, familiar, and decisive.
- **Shape:** Gently curved corners (`{rounded.sm}`), a 36px minimum height, and 7px by 12px internal padding.
- **Primary:** Decisive Violet with On Accent content. Use once per decision region for the action that advances work.
- **Secondary:** Record Surface with a Hairline boundary and Structural Rest shadow. Use for safe, reversible actions.
- **Ghost:** Transparent with Muted Graphite content; hover adds Queue Wash. Use for dismissal, pagination, and tertiary utilities.
- **Danger:** Conflict Red on Conflict Red Wash. Reserve for destructive or negative outcomes.
- **Hover / Focus / Active:** Shift primary controls to Pressed Violet, show the 3px Focus Violet outline, and use a 1px downward press only on active pointer state.
- **Disabled / Loading:** Preserve the control's size, use Pressed Surface and Faint Graphite, disable pointer affordance, and replace the action label with an explicit progress label when work is pending.

### Inputs / Fields

- **Style:** A 38px Record Surface control with a Strong Hairline boundary, gently curved corners (`{rounded.sm}`), and compact body text.
- **Focus:** Keep the field in place; shift the border to Decisive Violet and add a visible 3px pale-violet focus outline.
- **Labels:** Place persistent labels above fields. Hints sit below and explain constraints, units, freshness, or consequences.
- **Placeholder / Error / Disabled:** Placeholders use Muted Graphite, never Faint Graphite. Errors appear directly beside the field in Conflict Red with text. Disabled controls retain a visible label and explain why they are unavailable.

### Chips

- **Style:** Compact 22px semantic badges with full-pill corners (`{rounded.full}`), 3px by 7px padding, a tinted background, readable same-hue text, and a subtle full border.
- **State:** Neutral identifies metadata; green confirms; amber requests review; red blocks or rejects; blue informs. Every badge contains a plain-language state, never a color alone.

### Cards / Containers

- **Corner Style:** Top-level panels use gently curved 13px corners (`{rounded.lg}`); nested rows and grouped records use 9px (`{rounded.md}`).
- **Background:** Record Surface is the working plane; Queue Wash is reserved for rails, settings labels, tab bars, and secondary zones.
- **Shadow Strategy:** Top-level surfaces may use Structural Rest. Nested records use borders or tonal contrast, never floating-card shadows.
- **Border:** Hairlines define structure. Selected rows use a full Strong Hairline or violet outline plus Violet Wash—not a colored side stripe.
- **Internal Padding:** 12–20px according to density. A panel heading is visually joined to its body rather than nested inside another card.

### Navigation

- **Desktop:** A 218px sticky left rail with four primary destinations. Each item is at least 40px high; inactive items use Muted Graphite and the active item uses Violet Ink on Record Surface.
- **Compact desktop:** Collapse the rail to icons at laptop widths while retaining tooltips and accessible labels.
- **Mobile:** At 760px and below, use a 60px fixed bottom bar with four equally sized destinations and 44px minimum targets.
- **Tabs:** Workspace tabs sit on Queue Wash, use text plus optional counts, and identify the active tab with Violet Ink and a 2px bottom indicator.

### Review Queue and Workspace

- **Character:** This is the signature pattern: a compact queue on the left and one complete company record on the right.
- **Queue row:** Show company, stage/location, hiring signal, contact route, and conflict state in a predictable scan order. The selected row uses Record Surface plus a full outline or soft violet ring.
- **Workspace:** Keep the company header and final decision controls anchored while evidence scrolls between them. Reuse the same Overview, People, Evidence, and History tabs across every record.
- **Responsive behavior:** Below 760px, show either queue or workspace and provide an explicit back-to-queue action. Preserve selection and scroll context.

### Notices and Dialogs

- **Notices:** Use a full semantic border and pale tonal fill with text or an icon. Polite status updates use `role="status"`; blocking errors use `role="alert"`.
- **Dialogs:** Reserve dialogs for focused editing, confirmation, or credential entry that cannot remain inline. Use one title, optional short description, a close control, and actions aligned at the bottom.
- **Motion:** Fade the overlay in over 120ms and lift the dialog over 140ms. Honor reduced motion by switching immediately.

## Do's and Don'ts

### Do:

- **Do** keep one obvious primary action per decision region and use Decisive Violet only for action, current selection, or focus.
- **Do** place source, freshness, conflict, and verification evidence beside the fact it qualifies.
- **Do** use the queue-and-workspace pattern to preserve context while reviewing one company bundle at a time.
- **Do** pair semantic color with a plain-language label, icon, or both.
- **Do** keep focus rings visible at 3px and preserve keyboard order through navigation, queues, tabs, dialogs, and decision controls.
- **Do** keep compact desktop controls at least 36px high and mobile navigation targets at least 44px high.
- **Do** use full borders, background tints, and tonal layering to show selection and hierarchy.
- **Do** retain empty, loading, error, disabled, and completed states for every workflow.
- **Do** keep all data, credential, local-only, and send-safeguard messaging candid and close to the affected action.

### Don't:

- **Don't** create bloated enterprise CRMs with deep configuration trees and duplicate concepts.
- **Don't** turn the product into a sales-engagement dashboard that gamifies activity volume instead of showing evidence quality.
- **Don't** use dark neon “hacker” styling, generic AI gradients, glassmorphism, or novelty interfaces.
- **Don't** build spreadsheet replicas that expose every field at once and make review feel like data entry.
- **Don't** introduce multi-step wizards for actions that can be completed in one clear screen.
- **Don't** use a colored `border-left` or `border-right` greater than 1px as a selected-row, card, notice, or callout stripe; use a full outline or tonal fill.
- **Don't** pair a 1px border with a shadow blur of 16px or more on the same surface.
- **Don't** use gradient text, decorative grid backgrounds, repeating stripe backgrounds, or ornamental glass effects.
- **Don't** apply green, amber, red, blue, or saturated violet to inactive states or for decoration.
- **Don't** use Faint Graphite for placeholders, instructions, or required decision context.
- **Don't** hide uncertainty behind a single score; show the underlying evidence, age, and conflicts.
- **Don't** use decorative motion, orchestrated page-load sequences, bounce, or elastic easing.
- **Don't** reinvent native form, dialog, tab, navigation, or scrolling affordances for personality.
