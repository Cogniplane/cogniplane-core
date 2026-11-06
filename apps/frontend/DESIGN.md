---
name: Cogniplane
description: The calm control room for governed enterprise AI work.
colors:
  command-ink: "#0f172a"
  signal-teal: "#1f7e86"
  signal-teal-strong: "#17646b"
  operational-mist: "#f0f4f7"
  operational-layer: "#e8eff3"
  operational-layer-high: "#e1e9ee"
  clear-surface: "#ffffff"
  slate-voice: "#48575f"
  faint-slate: "#52636d"
  evidence-blue: "#3d5a99"
  verified-green: "#1a7a4a"
  attention-amber: "#7a5c00"
  guardrail-red: "#9f403d"
  control-boundary: "#7b868c"
  divider: "rgba(169, 180, 185, 0.32)"
  dark-canvas: "#10141b"
  dark-surface: "#151b23"
  dark-raised: "#202834"
  dark-layer: "#24303c"
  dark-control-boundary: "#8593a8"
  dark-text: "#e2e9f3"
  dark-signal-teal: "#56c6cd"
typography:
  headline:
    fontFamily: "Manrope, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Manrope, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Inter, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: "1rem"
    letterSpacing: "0.08em"
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.command-ink}"
    textColor: "{colors.clear-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.operational-mist}"
    textColor: "{colors.signal-teal-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  input:
    backgroundColor: "{colors.clear-surface}"
    borderColor: "{colors.control-boundary}"
    textColor: "{colors.command-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  card:
    backgroundColor: "{colors.clear-surface}"
    borderColor: "{colors.divider}"
    textColor: "{colors.command-ink}"
    rounded: "{rounded.lg}"
    padding: "24px"
  chip:
    backgroundColor: "{colors.operational-layer}"
    textColor: "{colors.slate-voice}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
---

# Design System: Cogniplane

## 1. Overview

**Creative North Star: "The Calm Control Room"**

Cogniplane is a focused operational environment where knowledge work remains central and governance becomes visible exactly when it matters. Its cool, layered surfaces reduce visual noise; compact, familiar controls support sustained work; and Signal Teal marks the few elements that need orientation or action. The system feels assured, precise, and approachable without becoming sterile.

The interface is information-dense where administrators need evidence and deliberately quiet where employees converse, draft, and handle artifacts. Workspace, settings, and administration share one visual language. Responsive layouts change structure rather than shrinking type: rails become drawers, multi-column groups stack, and consequential actions retain full clarity.

This system explicitly rejects the generic consumer chatbot and complex enterprise software. It must never reduce Cogniplane to a transcript and prompt box, nor expose platform architecture before a person needs it.

**Key Characteristics:**

- Cool tonal layers with a restrained teal orientation signal
- Compact, familiar controls with strong keyboard and state feedback
- Information density organized by hierarchy, not decoration
- Governance states that are specific, legible, and impossible to miss
- Light and dark themes with equivalent semantic roles

## 2. Colors

The palette combines Command Ink, cool Operational Mist layers, and a rare Signal Teal accent; semantic colors communicate evidence and consequence rather than decorate surfaces. The frontmatter is the normative token source.

### Primary

- **Command Ink:** The workhorse for primary actions and highest-emphasis text in the light theme. It provides authority without making every action look branded.
- **Signal Teal:** Active navigation, selected controls, focus rings, links, and small moments that orient the user. Signal Teal Strong carries readable teal text on pale surfaces.

### Secondary

- **Evidence Blue:** Informational status, non-interactive evidence, and data-series distinction. It never competes with Signal Teal for primary action.
- **Verified Green:** Successful completion and confirmed healthy states.
- **Attention Amber:** Pending approval, caution, and situations requiring attention.
- **Guardrail Red:** Errors, blocked actions, destructive intent, and policy violations.

### Neutral

- **Operational Mist:** Low-contrast rails, toolbars, and supporting panels.
- **Operational Layer / Layer High:** Nested tonal separation and hover or selected surfaces without unnecessary borders.
- **Clear Surface:** Content containers, popovers, and focused work surfaces in the light theme.
- **Slate Voice / Faint Slate:** Secondary and tertiary text. Faint Slate is limited to metadata and nonessential labels; body copy uses Slate Voice or stronger.
- **Dark Canvas / Dark Surface / Dark Layer / Dark Text:** Equivalent dark-theme roles. Dark Signal Teal is lifted for contrast rather than mechanically reusing the light accent.
- **Dark Raised:** Menus, popovers, dialogs, and drawers in dark mode. It sits one step above cards, so an overlay never looks lower than the page it covers.

### Boundaries

- **Divider:** Faint edges of static containers, rows, and layout regions. A divider groups content; it never identifies a control on its own. A bare `border` class resolves to this color.
- **Control Boundary:** The edge of every input, select, textarea, outline button, and native form control. It keeps at least 3:1 against every surface a control sits on (light surfaces up to Operational Layer High; dark surfaces up to the brightest dark layer). It is an edge color only; controls fill with the separate control surface token.
- **Hover surface (`accent`):** The background of a hovered or focused menu item, select option, or ghost button. It is never a text, border, or chart color. Foregrounds use Evidence Blue (`info`), Signal Teal (`brand`), or a status color with its paired surface. Charts use the shared `chart-1` to `chart-5` palette.

### Named Rules

**The Signal Rarity Rule.** Signal Teal marks action, focus, or location and occupies no more than a small fraction of a screen. Its rarity is what makes it useful.

**The Semantic Integrity Rule.** Green, amber, red, and blue always communicate state or evidence. They are forbidden as arbitrary decoration.

**The Theme Equivalence Rule.** Dark mode preserves hierarchy and meaning; it is not a neon restyle of the light interface.

## 3. Typography

**Display Font:** Manrope (with sans-serif fallback)
**Body Font:** Inter (with sans-serif fallback)
**Label/Mono Font:** Inter for labels; the system monospace stack only for code, versions, and machine identifiers.

**Character:** Manrope gives headings compact authority while Inter keeps dense controls and data readable. The pairing is practical and contemporary, with a tight scale suited to a product people use for extended periods.

### Hierarchy

- **Headline** (600, 1.5rem, 1.25): Page titles and the strongest heading on administrative or settings surfaces.
- **Title** (600, 1rem, 1.4): Panel headings, session titles, dialog titles, and compact section hierarchy.
- **Body** (400, 0.875rem, 1.6): Product copy, controls, and explanatory text. Prose is capped near 70 characters; tables and operational data may run wider.
- **Label** (600, 0.6875rem / 11px, 0.08em letter spacing, `text-label`): Sparse group labels for rows or metrics and compact metadata. Never smaller; 10px uppercase text is below the readable floor. Uppercase labels are never repeated as decorative eyebrows across every section, and a page title has no eyebrow above it.
- **Caption** (400, 0.75rem): Supporting metadata, timestamps, and menu item descriptions. Status chips use the caption size with medium weight.

### Named Rules

**The Working Scale Rule.** Product typography uses fixed sizes and a restrained ratio. Fluid display type and oversized marketing hierarchy are prohibited inside the application.

**The Plain-Language Label Rule.** Labels name the object or action directly. Typography never compensates for unclear wording.

## 4. Elevation

Cogniplane is layered and restrained. Depth comes first from adjacent cool surface tones, then from borders where boundaries require precision. Shadows are reserved for elements that genuinely rise above the workspace: menus, dialogs, drawers, and interactive surfaces during lift. Dark mode uses stronger ambient shadows because tonal boundaries need more support.

### Shadow Vocabulary

- **Low ambient** (`0 2px 8px rgba(42, 52, 57, 0.06)`): Compact floating controls and subtle interactive lift in light mode.
- **Raised ambient** (`0 4px 24px rgba(42, 52, 57, 0.08)`): Menus, transient panels, and deliberate hover lift.
- **Modal ambient** (`0 8px 40px rgba(42, 52, 57, 0.10)`): Dialogs and drawers only.
- **Dark low / raised / modal** (`0 8px 24px rgba(0, 0, 0, 0.16)`, `0 16px 40px rgba(0, 0, 0, 0.20)`, `0 24px 64px rgba(0, 0, 0, 0.24)`): Theme-equivalent floating elevation on dark surfaces.

Dialogs and alert dialogs never exceed the viewport (`100dvh` minus 2rem). Their body scrolls and the footer with the decision stays pinned at the bottom. A dialog that scrolls its whole body reserves a band for Close. Callers with their own scrolling layout use `scrollBody={false}` and keep a fixed or sticky header with room for Close. Hiding that button during a save must preserve the form and its focus. Escape and the close button dismiss unless a pending save requires the dialog to stay open. Under reduced motion, overlay enter and exit animations finish at once.

### Named Rules

**The Layer-Before-Shadow Rule.** Use tonal separation before adding elevation. A static container does not earn a shadow merely because it has content.

**The One Boundary Rule.** Do not combine a decorative border with a broad shadow on the same static card. Pick the boundary the hierarchy actually requires.

## 5. Components

**Component philosophy: quiet controls, decisive states.** Controls remain familiar and restrained at rest; focus, selection, approval, warning, and error states become unmistakable.

### Buttons

- **Shape:** Gently compact corners (8px) with heights from 24px for dense inline actions to 40px for prominent actions; 36px is the default.
- **Primary:** Command Ink with clear high-contrast text and 16px horizontal padding. Use for the single strongest action in a local decision set.
- **Hover / Focus:** A 150ms standard ease, slight color shift, and a 3px translucent Signal Teal focus ring. Active press scales to 0.985; reduced motion removes the transform.
- **Header toolbars:** Icon-only actions use the ghost style. The desktop Jump control keeps its outline when its label and shortcut are visible. On phones it becomes a ghost icon like its neighbors.
- **Secondary / Outline / Ghost:** Pale Signal Teal surfaces identify selected or secondary emphasis. Outline buttons mark neutral alternatives. Ghost buttons are reserved for icon and low-emphasis actions.
- **Destructive:** A solid Guardrail Red fill with its paired foreground in both themes: white text in light, dark ink on the lifted coral in dark. Never a translucent red under white text.
- **Disabled / Loading:** Disabled controls remain visible at 50% opacity and cannot receive pointer events. Loading text states the ongoing action.

### Chips

- **Style:** Compact 4px corners, 2px vertical and 6px horizontal padding, and semantic tonal backgrounds.
- **State:** Neutral chips carry metadata; semantic chips carry evidence or status. Full pills are reserved for badges whose compact capsule shape improves scanning.

### Cards / Containers

- **Corner Style:** 8px for dense list containers, 12px for standard cards, and 16px only for singular prominent surfaces.
- **Background:** Clear Surface over Operational Mist or Operational Layer. Nested cards are prohibited; use spacing, dividers, or tonal sections inside a container.
- **Shadow Strategy:** Flat. The shared Card has no shadow. Refer to the Layer-Before-Shadow Rule.
- **Border:** A faint full perimeter only when adjacent tones do not provide enough structure. Colored side stripes are prohibited.
- **Internal Padding:** 12–16px for dense operational items and 24px for standard cards.

### Inputs / Fields

- **Style:** 36px default height, 8px corners, a Control Boundary edge (3:1), a theme-aware control surface, and 12px horizontal padding. Native selects, textareas, and checkboxes follow the same boundary, and the page declares `color-scheme` so native menus and checkboxes match the theme.
- **Focus:** Border shifts to Signal Teal with a 3px translucent ring. Placeholder text must remain readable, not ornamental gray.
- **Error / Disabled:** Guardrail Red border and ring communicate invalid state. Disabled fields remain legible and show unavailable interaction through opacity and cursor.

### Navigation

- **Style:** Cool tonal rails and headers frame content without competing with it. Default items use Slate Voice; hover uses a slightly stronger tonal layer; active items use a complete Signal Teal surface and readable teal text, never a decorative side stripe.
- **Typography:** Compact body text. Group labels are short sentence-case captions that name a `role="group"` of links.
- **Responsive treatment:** Desktop rails collapse into fixed drawers below 768px. Drawers use an explicit backdrop, Escape dismissal, internal scrolling on short screens, and 40px touch targets rather than squeezing the content column.
- **Session drawer on short screens:** Below 600px in height, the full sidebar scrolls and the session list keeps a useful height. Its close control remains outside that scrolling area. A closed rail is inert; an open phone drawer contains focus and returns it to the header on dismissal.
- **Tabs:** Inactive tabs use Slate Voice. The line variant marks the selected tab with a Signal Teal indicator; the default variant raises the selected tab onto a lighter surface.
- **Workspace header:** When the header is narrower than 720px, it uses two rows: session identity (sidebar, title, account) above session tools (status, capabilities, actions, jump, artifacts). Copy moves into the session menu and the theme into the account menu. Touch targets are 40px there and 32px on desktop. Approval status never leaves the screen.
- **Account menu:** One shared menu for every header: the person, destinations, organization switching, shortcuts, and log out. Admin appears only for owners and admins. This is presentation only; AuthGuard and the backend decide access.
- **Console headers:** A transparent title and toolbar align with the content column below. The layout supplies the same column width and horizontal inset for the header and content. A header adds no second inset or filled band.
- **Theme:** Light or dark, chosen by the person and saved in the browser. The app does not follow the system setting. If the browser blocks saving, the theme still changes for the page and a notice says it will not be kept.

### Approval State

Approval is a signature governance component. It pairs a complete Attention Amber tonal surface (one faint amber perimeter, no side stripe, no shadow) and icon with a direct title, exact action summary, and a clear hierarchy between decline, approve once, and turn-scoped approval. The component must explain consequence before requesting a decision and must not rely on amber alone to communicate urgency.

## 6. Do's and Don'ts

### Do:

- **Do** keep research, writing, analysis, conversation, and artifacts visually primary.
- **Do** use Signal Teal only for action, focus, selection, or orientation.
- **Do** reveal governance and runtime detail progressively, at the moment it helps a decision.
- **Do** preserve equivalent semantic meaning, contrast, and hierarchy in light and dark themes.
- **Do** maintain complete keyboard operation, visible focus, reduced-motion behavior, and color-independent status cues to meet WCAG 2.2 AA.
- **Do** use familiar control shapes and wording consistently across workspace, settings, and administration.

### Don't:

- **Don't** make Cogniplane look like a **generic consumer chatbot** whose identity stops at a transcript and prompt box.
- **Don't** make Cogniplane feel like **complex enterprise software** that exposes architecture or configuration before it becomes relevant.
- **Don't** use colored side stripes on cards, navigation items, approvals, alerts, or list rows; use complete surfaces, icons, and text hierarchy.
- **Don't** nest cards or repeat identical icon-heading-description card grids where a list, table, or continuous section communicates structure better.
- **Don't** pair a faint border with a broad decorative shadow on a static element.
- **Don't** use gradients, glass effects, oversized rounding, or decorative motion as substitutes for hierarchy.
- **Don't** communicate success, attention, danger, or informational state through color alone.
