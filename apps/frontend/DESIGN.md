---
name: Cogniplane
description: Visual rules for the Cogniplane workspace and admin console.
colors:
  command-ink: "#0f172a"
  on-command-ink: "#f7f7ff"
  signal-teal: "#1f7e86"
  signal-teal-strong: "#17646b"
  signal-teal-surface: "rgba(44, 155, 160, 0.12)"
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
  caption:
    fontFamily: "Inter, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
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
    textColor: "{colors.on-command-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.signal-teal-surface}"
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
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
---

# Design System: Cogniplane

Scope: visual rules for the frontend. Read it with `PRODUCT.md` before UI work.

## 1. Overview

Product intent and anti-references are in `PRODUCT.md`. This file sets the
visual rules. Code uses the tokens in `apps/frontend/src/app/globals.css`; the
frontmatter mirrors them for design tools. Change both together.
`scripts/doc-links.test.ts` checks that each frontmatter color exists in
`globals.css` and that each component names a defined color; it does not check
which role a color has in code.

Responsive layouts change structure (rails become drawers, columns stack); they
do not shrink type.

## 2. Colors

Code names: each color is a CSS variable in `globals.css` (`dark-*` in the dark
theme block). `scripts/doc-links.test.ts` checks this table.

| Color | CSS variable |
|---|---|
| `command-ink` | `--color-primary` |
| `on-command-ink` | `--color-on-primary` |
| `signal-teal` | `--color-brand` |
| `signal-teal-strong` | `--color-brand-strong` |
| `signal-teal-surface` | `--color-brand-surface` |
| `operational-mist` | `--color-surface-container-low` |
| `operational-layer` | `--color-surface-container` |
| `operational-layer-high` | `--color-surface-container-high` |
| `clear-surface` | `--color-surface-container-lowest` |
| `slate-voice` | `--color-on-surface-variant` |
| `faint-slate` | `--color-on-surface-faint` |
| `evidence-blue` | `--color-info` |
| `verified-green` | `--color-success` |
| `attention-amber` | `--color-warning` |
| `guardrail-red` | `--color-danger` |
| `control-boundary` | `--color-input` |
| `divider` | `--color-border` |
| `dark-canvas` | `--color-background` |
| `dark-surface` | `--color-surface` |
| `dark-raised` | `--color-popover` |
| `dark-layer` | `--color-surface-container` |
| `dark-control-boundary` | `--color-input` |
| `dark-text` | `--color-on-surface` |
| `dark-signal-teal` | `--color-brand` |

### Primary

- **Command Ink:** Primary actions and highest-emphasis text in the light theme.
- **Signal Teal:** Active navigation, selected controls, focus rings and links. Signal Teal Strong carries readable teal text on pale surfaces.

### Secondary

- **Evidence Blue:** Informational status, non-interactive evidence, and data-series distinction. It is never used for a primary action.
- **Verified Green:** Successful completion and confirmed healthy states.
- **Attention Amber:** Pending approval, caution, and situations requiring attention.
- **Guardrail Red:** Errors, blocked actions, destructive intent, and policy violations.

### Neutral

- **Operational Mist:** Low-contrast rails, toolbars, and supporting panels.
- **Operational Layer / Layer High:** Nested tonal separation and hover or selected surfaces without unnecessary borders.
- **Clear Surface:** Content containers, popovers, and focused work surfaces in the light theme.
- **Slate Voice / Faint Slate:** Secondary and tertiary text. Faint Slate is limited to metadata and nonessential labels; body copy uses Slate Voice or stronger.
- **Dark Canvas / Dark Surface / Dark Layer / Dark Text:** Equivalent dark-theme roles. Dark Signal Teal is lighter than the light accent, for contrast.
- **Dark Raised:** Menus, popovers, dialogs, and drawers in dark mode. It is one step lighter than cards.

### Boundaries

- **Divider:** Faint edges of static containers, rows, and layout regions. A divider groups content; it never identifies a control on its own. A bare `border` class resolves to this color.
- **Control Boundary:** The edge of every input, select, textarea, outline button and native form control.
  - Contrast: at least 3:1 against every surface a control sits on, up to Operational Layer High (light) and the brightest dark layer (dark).
  - Edge only: controls fill with the control surface token.
- **Hover surface (`accent`):** The background of a hovered or focused menu item, select option, or ghost button. It is never a text, border, or chart color. Foregrounds use Evidence Blue (`info`), Signal Teal (`brand`), or a status color with its paired surface. Charts use the shared `chart-1` to `chart-5` palette.

Green, amber, red and blue always show state or evidence, never decoration.

## 3. Typography

Fonts and sizes are the `typography` tokens in the frontmatter. Use the system monospace stack only for code, versions and machine identifiers.

### Hierarchy

- **Headline**: Page titles and the strongest heading on administrative or settings surfaces.
- **Title**: Panel headings, session titles, dialog titles, and compact section hierarchy.
- **Body**: Product copy, controls, and explanatory text. Prose is capped near 70 characters; tables and operational data may run wider.
- **Label**: Sparse group labels for rows or metrics and compact metadata. Do not go smaller: 10px uppercase text is not readable. Do not repeat uppercase labels as decoration above each section or above a page title.
- **Caption**: Supporting metadata, timestamps, menu item descriptions, chips and status pills.

Use fixed type sizes with a small ratio. No fluid display type or marketing-size headings in the application.

## 4. Elevation

Shadows are only for elements above the workspace: menus, dialogs, drawers, and interactive surfaces during lift. Dark mode uses stronger shadows.

### Shadow Vocabulary

Values are the `--elevation-*` tokens in `globals.css` (light and dark).

- **Low** (`--elevation-low`, `shadow-sm`): compact floating controls and small hover lift.
- **Raised** (`--elevation-raised`, `shadow-md`): menus, transient panels, deliberate hover lift.
- **Modal** (`--elevation-modal`, `shadow-lg`): dialogs and drawers only.

Dialogs:

- Never exceed the viewport (`100dvh` minus 2rem). The body scrolls; the footer with the decision stays pinned.
- A dialog that scrolls its whole body reserves a band for Close. With `scrollBody={false}`, the caller keeps a fixed or sticky header with room for Close.
- Hiding Close during a save keeps the form and its focus.
- Escape and Close dismiss, unless a pending save keeps the dialog open.
- Under reduced motion, enter and exit animations finish at once.

## 5. Components

Controls are plain at rest; focus, selection, approval, warning and error states are always visible.

### Buttons

- **Shape:** frontmatter `button-*` tokens; smaller heights for dense inline actions, larger for prominent ones.
- **Primary:** the single strongest action in a local decision set.
- **Hover / Focus:** A 150ms standard ease and a slight color shift; the shared focus ring (see Do's). Active press scales to 0.985; reduced motion removes the transform.
- **Header toolbars:** icon-only actions use the ghost style.
- **Secondary / Outline / Ghost:** Pale Signal Teal surfaces identify selected or secondary emphasis. Outline buttons mark neutral alternatives. Ghost buttons are reserved for icon and low-emphasis actions.
- **Destructive:** A solid Guardrail Red fill with its paired foreground in both themes: white text in light, dark ink on the lighter dark-theme red in dark. Never a translucent red under white text.
- **Disabled / Loading:** Disabled controls remain visible at 50% opacity and cannot receive pointer events. Loading text states the ongoing action.

### Chips

Classes are in `apps/frontend/src/lib/ui-tokens.ts`.

- **Chip** (`CHIP`, frontmatter `chip`): metadata on a neutral surface.
- **Status pill** (`PILL_*`): status or evidence. Full rounding, caption size with medium weight, the status color on its paired surface.

### Cards / Containers

- **Corner Style:** 8px for dense list containers, 12px for standard cards, and 16px only for singular prominent surfaces.
- **Background:** Clear Surface over Operational Mist or Operational Layer. Inside a container, use spacing, dividers or tonal sections.
- **Shadow:** none on the shared Card.
- **Border:** A faint full perimeter only when adjacent tones do not provide enough structure. Colored side stripes are prohibited.
- **Internal Padding:** 12–16px for dense operational items and 24px for standard cards.

### Inputs / Fields

- **Style:** frontmatter `input` token: a Control Boundary edge on the control surface.
- **Native controls:** selects, textareas and checkboxes use the same edge. The page declares `color-scheme`, so native menus match the theme.
- **Focus:** the border turns Signal Teal, with the shared focus ring. Placeholder text must remain readable, not ornamental gray.
- **Error / Disabled:** Guardrail Red border and ring communicate invalid state. Disabled fields remain legible and show unavailable interaction through opacity and cursor.

### Navigation

- **Style:** Default items use Slate Voice; hover uses a stronger tonal layer; active items use a complete Signal Teal surface with readable teal text, never a side stripe.
- **Group labels:** short sentence-case captions that name a `role="group"` of links.
- **Responsive:** rails become drawers on narrow screens, with a backdrop, Escape to close, internal scrolling and 40px touch targets. A closed rail is inert; an open drawer contains focus and returns it on close. Breakpoints are in the layout components.
- **Tabs:** inactive tabs use Slate Voice; the selected tab has a Signal Teal indicator (line variant) or a lighter surface (default variant).
- **Headers:** console headers align with the content column and add no inset or filled band. Approval status always stays visible in the workspace header.
- **Theme:** light or dark, chosen by the person and saved in the browser; the app does not follow the system setting.

### Approval State

- Surface: full Attention Amber tonal fill, one faint amber perimeter, an icon; no side stripe, no shadow.
- Content: a direct title and the exact action, then the consequence, then the decision.
- Actions: decline and approve once; approve for the turn only when the request allows it (`allowForTurn`). Keep a clear order of emphasis.
- Do not use amber as the only sign of urgency.

## 6. Do's and Don'ts

### Do:

- **Do** meet WCAG 2.2 AA (the target in `PRODUCT.md`): text contrast 4.5:1 (3:1 for large text); control edges and focus indicators 3:1.
- **Do** keep full keyboard operation and the shared focus ring: 3px, translucent Signal Teal.
- **Do** keep layouts usable at 200% browser zoom.
- **Do** pair every status color with an icon or text.

### Don't:

- **Don't** match the anti-references in `PRODUCT.md`.
- **Don't** nest cards or repeat identical icon-heading-description card grids where a list, table, or continuous section communicates structure better.
- **Don't** use gradients, glass effects, oversized rounding, or decorative motion as substitutes for hierarchy.
