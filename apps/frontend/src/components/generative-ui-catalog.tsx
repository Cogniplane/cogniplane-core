"use client";
// The UI that the agent can write in ```a2ui fences of a reply (CopilotKit's
// markdown transport). It is CopilotKit's standard catalog, all 69 components,
// with two changes.
//
// 1. A generated control never runs model-defined code. The agent writes the
//    event callbacks of a component (`onClick`, `onVisible`, `onSubmit`, and
//    the rest that the catalog declares in `events`), and CopilotKit turns
//    each one into a prop. A callback can send a message to the agent, or call
//    a built-in function such as `openUrl`. `onVisible` runs without a click,
//    and `openUrl` accepts any task that the browser still counts as a user
//    gesture, such as the click on Send, or every task when the browser has no
//    `navigator.userActivation`. So every standard component that declares
//    events renders without those props. Data props, bindings, `calc`, and
//    the setters of writable props (`setValue`, `setSelected`) stay, so local
//    input still works. A link with an `href` still opens on a click of the
//    user. The model still reads the events in its schema, and they do
//    nothing. Paint props also reject CSS and SVG resource URLs. A Modal also
//    renders without `open` and `setOpen`, a literal or a binding: it opens
//    only from a click of the user on its trigger. A model `open` would put a
//    dialog over the page and move the focus, also from the closed side panel.
// 2. The components that load from the network use the rules of agent-authored
//    markdown (SafeMarkdown, MarkdownImage).
//
// Agent-authored URLs never load by themselves. A prompt-injected agent could
// encode data in a URL and read it from the request, so a component fetches
// nothing from a host that is not ours, and the CSP stays as it is.
//
//   Image, ImageGrid, CarouselMediaItem   MarkdownImage: our own sources render,
//                                         other sources become a click-through link
//   LinkCard, EntityCard, Citation        text and links; an image follows the rule above
//   Favicon                               the first letter of the host
//   Video, AudioPlayer                    a link to the file, never a player
//   Map                                   the list of locations; no tiles load
//   HtmlView                              the source as text, never an iframe
//   Markdown                              SafeMarkdown
//
// DeepAgentsBrowserAgent also refuses any run that generated UI starts, in case
// an event gets through.
//
// The catalog adds four application components. None has events, so none has
// model callbacks. The catalog keeps its id: a surface saved before them names
// the same catalog and renders as before.
//
//   ArtifactCard (artifact-card.tsx)       the model sets only its `artifactId`
//   Checklist (checklist-card.tsx)         items, title, and start values; the user
//                                          edits `checked` and `notes`, which the
//                                          model binds to data model paths
//   ComparisonTable (comparison-table.tsx) read-only: columns, rows, and cells,
//                                          with "No data" for a missing cell
//   StatusSummary (status-summary.tsx)     read-only: rows with a status from a
//                                          fixed list, and optional counts

import {
  ArtifactCardPropsSchema,
  CHECKLIST_LIMITS,
  ChecklistPropsSchema,
  COMPARISON_TABLE_LIMITS,
  ComparisonTablePropsSchema,
  GENERATIVE_UI_CATALOG_ID,
  STATUS_SUMMARY_LIMITS,
  STATUS_SUMMARY_STATUSES,
  StatusSummaryPropsSchema
} from "@cogniplane/shared-types";
import { createGenerativeUI, standardUI } from "@copilotkit/react-core/v2/generative-ui";
import { createContext, useContext, useId, type ComponentType, type ReactNode } from "react";

import { GenerativeArtifactCard } from "./artifact-card";
import { GenerativeChecklist } from "./checklist-card";
import { GenerativeComparisonTable } from "./comparison-table";
import { MarkdownImage } from "./markdown-image";
import { SafeMarkdown } from "./safe-markdown";
import { GenerativeStatusSummary } from "./status-summary";
import { GenerativeCarousel, GenerativeChart } from "./generative-ui-defaults";
import {
  externalHost,
  formatCoordinate,
  formatRating,
  gridColumns,
  hostInitial,
  hostLabel,
  opensExternally,
  safeLinkHref,
  safePaintProps
} from "./generative-ui-catalog.logic";

// The props that each override reads, from the standard schemas of CopilotKit
// 1.83.0. CopilotKit's own prop types do not help here: with the app's Zod
// they resolve to `any`. The host test renders every component with the real
// props, so a rename in a later CopilotKit shows there.
type ImageProps = { url: string; description?: string };
type ImageGridProps = {
  images?: Array<{ url: string; description?: string; caption?: string; href?: string }>;
  columns?: number;
};
type CarouselMediaItemProps = {
  url: string;
  description?: string;
  size?: keyof typeof SIZES;
  href?: string;
  children?: ReactNode;
};
type LinkCardProps = { href: string; title: string; description?: string; image?: string; domain?: string };
type EntityCardProps = {
  title: string;
  subtitle?: string;
  description?: string;
  image?: string;
  meta?: string;
  badge?: { label: string };
  rating?: number;
  ratingCount?: number;
  href?: string;
  actions?: Array<{ label: string; href?: string }>;
};
type CitationProps = { index?: number; label?: string; title?: string; url?: string; snippet?: string; source?: string };
type FaviconProps = { url: string; alt?: string };
type VideoProps = { url: string; title?: string };
type AudioPlayerProps = { url: string; description?: string };
type MapProps = {
  markers?: Array<{ label: string; lat: number; lng: number; category?: string }>;
  selected?: string;
  setSelected: (value: string) => void;
};
type HtmlViewProps = { html: string; title?: string };
type MarkdownProps = { text: string };

const CARD = "my-2 flex min-w-0 max-w-md flex-col gap-1 rounded-lg border border-outline-variant bg-surface-container-low p-3 text-sm [overflow-wrap:anywhere]";
const MUTED = "text-xs text-on-surface-variant";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const SIZES = { sm: "8rem", md: "12rem", lg: "16rem" } as const;

/** A link when the value is safe to open, else the text alone. */
function SafeLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const safe = safeLinkHref(href);
  if (!safe) return <span>{children}</span>;
  const external = opensExternally(safe);
  const host = externalHost(safe);
  return (
    <>
      <a
        href={safe}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        className={`rounded-sm font-medium text-brand underline underline-offset-2 [overflow-wrap:anywhere] ${FOCUS}`}
      >
        {children}
      </a>
      {host ? <span className={`ml-1 ${MUTED} [overflow-wrap:anywhere]`}>[external: {host}]</span> : null}
    </>
  );
}

function GenerativeImage({ url, description }: ImageProps) {
  return <span className="min-w-0 [overflow-wrap:anywhere]"><MarkdownImage src={url} alt={description} /></span>;
}

function GenerativeImageGrid({ images = [], columns }: ImageGridProps) {
  const count = Math.min(gridColumns(columns), Math.max(images.length, 1));
  return (
    <ul className="my-2 grid list-none gap-2 p-0" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, max(10rem, calc((100% - ${(count - 1) * 0.5}rem) / ${count}))), 1fr))` }}>
      {images.map((image, index) => (
        <li key={index} className="flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]">
          <MarkdownImage src={image.url} alt={image.description ?? image.caption} />
          {image.caption ? <span className={MUTED}>{image.caption}</span> : null}
          {safeLinkHref(image.href) ? <SafeLink href={image.href}>Open link</SafeLink> : null}
        </li>
      ))}
    </ul>
  );
}

function GenerativeCarouselMediaItem({ url, description, size = "md", href, children }: CarouselMediaItemProps) {
  return (
    <div className="flex min-w-0 max-w-full shrink-0 flex-col gap-1 [overflow-wrap:anywhere]" style={{ width: SIZES[size] }}>
      <MarkdownImage src={url} alt={description} />
      {safeLinkHref(href) ? <SafeLink href={href}>Open link</SafeLink> : null}
      {children}
    </div>
  );
}

function GenerativeLinkCard({ href, title, description, image }: LinkCardProps) {
  return (
    <div className={CARD}>
      {image ? <MarkdownImage src={image} alt="" /> : null}
      <SafeLink href={href}>{title}</SafeLink>
      {description ? <p className="m-0">{description}</p> : null}
      <span className={MUTED}>{hostLabel(href)}</span>
    </div>
  );
}

function GenerativeEntityCard({
  title, subtitle, description, image, meta, badge, rating, ratingCount, href, actions = []
}: EntityCardProps) {
  const score = formatRating(rating, ratingCount);
  return (
    <div className={CARD}>
      {image ? <MarkdownImage src={image} alt="" /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <SafeLink href={href}>{title}</SafeLink>
        {badge ? <span className="rounded-full border border-outline-variant px-2 text-xs">{badge.label}</span> : null}
      </div>
      {subtitle ? <span className={MUTED}>{subtitle}</span> : null}
      {description ? <p className="m-0">{description}</p> : null}
      {meta || score ? <span className={MUTED}>{[meta, score].filter(Boolean).join(" · ")}</span> : null}
      {actions.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-3 p-0">
          {actions.map((action, index) => (
            <li key={index}><SafeLink href={action.href}>{action.label}</SafeLink></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function GenerativeCitation({ index, label, title, url, snippet, source }: CitationProps) {
  const text = title ?? label ?? url ?? "Source";
  return (
    <span className="inline-flex min-w-0 max-w-full flex-col text-sm [overflow-wrap:anywhere]">
      <span>
        {index !== undefined ? <span className={`mr-1 ${MUTED}`}>[{index}]</span> : null}
        <SafeLink href={url}>{text}</SafeLink>
        {source ? <span className={`ml-1 ${MUTED}`}>{source}</span> : null}
      </span>
      {snippet ? <span className={MUTED}>{snippet}</span> : null}
    </span>
  );
}

function GenerativeFavicon({ url, alt }: FaviconProps) {
  return (
    <span
      role="img"
      aria-label={alt ?? hostLabel(url)}
      className="inline-flex size-4 items-center justify-center rounded-sm border border-outline-variant align-middle text-[11px] leading-none text-on-surface-variant"
    >
      {hostInitial(url)}
    </span>
  );
}

function GenerativeVideo({ url, title }: VideoProps) {
  return (
    <p className="my-2 text-sm [overflow-wrap:anywhere]">
      Video: <SafeLink href={url}>{title ?? hostLabel(url)}</SafeLink>
    </p>
  );
}

function GenerativeAudioPlayer({ url, description }: AudioPlayerProps) {
  return (
    <p className="my-2 text-sm [overflow-wrap:anywhere]">
      Audio: <SafeLink href={url}>{description ?? hostLabel(url)}</SafeLink>
    </p>
  );
}

// The standard Map loads map tiles from a third-party host. This one lists the
// locations. A click on a location sets the writable `selected` prop, which
// stays in the browser.
function GenerativeMap({ markers = [], selected, setSelected }: MapProps) {
  if (markers.length === 0) return <p className={`my-2 ${MUTED}`}>No locations to show.</p>;
  return (
    <ul className="my-2 flex max-w-md list-none flex-col gap-1 p-0 text-sm" aria-label="Locations">
      {markers.map((marker, index) => {
        const isSelected = marker.label === selected;
        return (
          <li key={index}>
            <button
              type="button"
              aria-pressed={isSelected}
              onClick={() => setSelected(marker.label)}
              className={`min-h-9 w-full rounded-md border px-3 py-2 text-left [overflow-wrap:anywhere] ${FOCUS} ${isSelected ? "border-brand bg-surface-container" : "border-input bg-control"}`}
            >
              <span className="font-medium">{marker.label}</span>
              <span className={`ml-2 ${MUTED}`}>
                {formatCoordinate(marker.lat)}, {formatCoordinate(marker.lng)}
                {marker.category ? ` · ${marker.category}` : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// The standard HtmlView renders `html` in a sandboxed iframe. Chat shows the
// source as text, which no browser runs.
function GenerativeHtmlView({ html, title }: HtmlViewProps) {
  return (
    <details className={CARD}>
      <summary className={`cursor-pointer rounded-sm ${FOCUS}`}>{title ? `${title} (HTML, not shown)` : "HTML content (not shown)"}</summary>
      <p className={MUTED}>Shown as text. This HTML does not run.</p>
      <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{html}</pre>
    </details>
  );
}

function GenerativeMarkdown({ text }: MarkdownProps) {
  return <SafeMarkdown>{text}</SafeMarkdown>;
}

type AnyProps = Record<string, unknown>;
// The components take props of many shapes, so the map of them cannot name one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

const StandardButton = standardUI.components.get("Button")!.component;
const StandardPressable = standardUI.components.get("Pressable")!.component;
const StandardForm = standardUI.components.get("Form")!.component;
const StandardBox = standardUI.components.get("Box")!.component;
const ACTION_UNAVAILABLE = "This action is unavailable in generated views. Ask in the chat to continue.";
const LocalModalTrigger = createContext(false);

// Keep the SDK's existing click-only URL and clipboard behavior. A submit
// button cannot complete a form after its model event has been removed.
function GenerativeButton(props: AnyProps) {
  const noteId = useId();
  const modalTrigger = useContext(LocalModalTrigger);
  const supportedLink = typeof props.href === "string" && /^(https?:|mailto:)/i.test(props.href.trim());
  const supportedCopy = typeof props.copy === "string" && props.copy !== "";
  if (!props.submit && (modalTrigger || supportedLink || (!props.href && supportedCopy))) return <StandardButton {...props} />;
  return (
    <span className="inline-flex min-w-0 max-w-full flex-col items-start gap-1 [overflow-wrap:anywhere]">
      <button type="button" disabled aria-describedby={noteId} className="min-h-9 max-w-full rounded-md border border-outline-variant bg-surface-container px-3 py-2 text-left text-sm text-on-surface-variant">
        {(props.child ?? props.children ?? props.label ?? props.text ?? "Action unavailable") as ReactNode}
      </button>
      <span id={noteId} className={MUTED}>{ACTION_UNAVAILABLE}</span>
    </span>
  );
}

function GenerativePressable(props: AnyProps) {
  const modalTrigger = useContext(LocalModalTrigger);
  const supportedLink = typeof props.href === "string" && /^(https?:|mailto:)/i.test(props.href.trim());
  if (modalTrigger || supportedLink) return <StandardPressable {...props} />;
  // A static container keeps its local input children operable.
  return <StandardBox {...props} role={undefined}>
    {props.children as ReactNode}
    <p className={`m-0 ${MUTED}`}>{ACTION_UNAVAILABLE}</p>
  </StandardBox>;
}

function GenerativeForm(props: AnyProps) {
  return <StandardForm {...props}>
    <p className={`m-0 ${MUTED}`}>These fields can be edited here. This form cannot submit. Ask in the chat to continue.</p>
    {props.children as ReactNode}
  </StandardForm>;
}

type FollowUpProps = { title?: string; items?: Array<string | { label: string; message?: string }> };
function GenerativeFollowUp({ title, items = [] }: FollowUpProps) {
  if (items.length === 0) return null;
  return <div className="my-2 min-w-0 text-sm [overflow-wrap:anywhere]">
    <p className="m-0 font-medium">{title ?? "Suggested prompts"}</p>
    <p className={`mb-1 mt-0 ${MUTED}`}>Suggestions only. Type a prompt in the chat to send it.</p>
    <ul className="m-0 list-disc space-y-1 pl-5">{items.map((item, index) => {
      const entry = typeof item === "string" ? { label: item } : item;
      return <li key={index}>{entry.label}{entry.message && entry.message !== entry.label ? <span className={`block ${MUTED}`}>{entry.message}</span> : null}</li>;
    })}</ul>
  </div>;
}

const ACTION_COMPONENTS: Record<string, AnyComponent> = {
  Button: GenerativeButton, Pressable: GenerativePressable, Form: GenerativeForm, FollowUp: GenerativeFollowUp
};

// Descriptions change the guide, while saved ids, schemas and bindings stay.
const SAFE_DESCRIPTIONS: Record<string, string> = {
  Button: "A button. Its existing click-only href, copy and local Modal trigger behavior is supported. Model events and form submission are unavailable and display an explanation. Use chat for requests that need the agent.",
  Pressable: "A container. Its existing click-only href and local Modal trigger behavior is supported. Otherwise it shows static content and an action-unavailable note. Local input children remain editable. Model events are unavailable.",
  Form: "A form layout with editable local fields. Submission and model events are unavailable. The view explains that the user must ask in chat to continue. Bind field values to data model paths to keep local edits.",
  FollowUp: "Read-only suggested prompts. Shows the labels and any different message text. The user must type a prompt in chat to send it. This component sends no message or event.",
  Image: "An image. App-hosted sources can render and open a local lightbox. External sources show a click-through link, and rejected URLs show text. Nothing external loads automatically.",
  ImageGrid: "A grid of images with optional captions and safe click-only links. One to four columns. App-hosted images render; external images show links. Nothing external loads automatically.",
  CarouselMediaItem: "A media item for a carousel. App-hosted images render; external images show links. Safe href opens only on user click. Size is capped to the available width. Children render below it.",
  LinkCard: "A title, description and safe click-only link. The host label comes from href, never domain. App-hosted images render; external images show links. No automatic external requests or model events.",
  EntityCard: "An entity summary with title, optional details, rating and click-only safe links. App-hosted images render; external images show links. Actions without safe href are text. Model events are unavailable.",
  Citation: "A source label with optional index, snippet and source text. Safe URLs open only on user click and show the external host. Rejected URLs show plain text.",
  Favicon: "A named host initial, or a question mark for an unknown host. No icon is downloaded.",
  Video: "A video file link, never an embedded player. Safe URLs open only on user click with the external host shown. Rejected URLs show text.",
  AudioPlayer: "An audio file link, never an embedded player. Safe URLs open only on user click with the external host shown. Rejected URLs show text.",
  Map: "A list of labeled coordinates, never a tile map. The user can select a location locally. Bind selected to a data model path to keep the choice. An empty list says there are no locations.",
  HtmlView: "HTML source in a disclosure, escaped as text. It never runs HTML or opens an iframe. Use title to name the source.",
  Markdown: "Markdown through the app's safe reading renderer. App-hosted images can render; external images show click-through links. Unsafe links and raw HTML cannot execute."
};

/** The component without the `blocked` props: the props that its events
 *  become, and MODEL_OPEN_PROPS. Every other prop, the setters of other
 *  writable props included, goes through. */
export function withoutModelEvents(
  name: string,
  Component: AnyComponent,
  blockedProps: readonly string[]
): AnyComponent {
  const blocked = new Set(blockedProps);
  function WithoutModelEvents(props: AnyProps) {
    const safe = safePaintProps(name, Object.fromEntries(Object.entries(props).filter(([key]) => !blocked.has(key))));
    // Modal owns this local click. Only its trigger receives the context;
    // model callbacks still pass through the same event filter.
    if (name === "Modal" && safe.trigger) safe.trigger = <LocalModalTrigger.Provider value>{safe.trigger as ReactNode}</LocalModalTrigger.Provider>;
    return <Component {...safe} />;
  }
  WithoutModelEvents.displayName = `WithoutModelEvents(${name})`;
  return WithoutModelEvents;
}

// The components that need their own rendering, whatever their events.
const NETWORK_SAFE_COMPONENTS: Record<string, AnyComponent> = {
  Image: GenerativeImage,
  ImageGrid: GenerativeImageGrid,
  CarouselMediaItem: GenerativeCarouselMediaItem,
  LinkCard: GenerativeLinkCard,
  EntityCard: GenerativeEntityCard,
  Citation: GenerativeCitation,
  Favicon: GenerativeFavicon,
  Video: GenerativeVideo,
  AudioPlayer: GenerativeAudioPlayer,
  Map: GenerativeMap,
  HtmlView: GenerativeHtmlView,
  Markdown: GenerativeMarkdown
};

// Props that the model could use to open an overlay without the user.
const MODEL_OPEN_PROPS: Record<string, readonly string[]> = { Modal: ["open", "setOpen"] };

/** Every renderer drops model events and unsafe paint values. */
const OVERRIDES = Object.fromEntries(
  [...standardUI.components].map(([name, standard]) => {
    const blocked = [...Object.keys(standard.events ?? {}), ...(MODEL_OPEN_PROPS[name] ?? [])];
    const component = ACTION_COMPONENTS[name] ?? NETWORK_SAFE_COMPONENTS[name]
      ?? ({ Chart: GenerativeChart, Carousel: GenerativeCarousel } as Record<string, AnyComponent>)[name]
      ?? standard.component;
    return [name, { component: withoutModelEvents(name, component, blocked) }];
  })
);

export const COGNIPLANE_GENERATIVE_UI = createGenerativeUI({
  id: GENERATIVE_UI_CATALOG_ID,
  extends: [standardUI],
  overrides: OVERRIDES,
  components: {
    ArtifactCard: {
      component: GenerativeArtifactCard,
      description:
        "A file of this chat, by its artifactId. The app shows the name, status, size, type and PII label "
        + "from its own records, and a Preview button that the user can click. Use only an artifactId of this "
        + "session. Set no other props.",
      props: ArtifactCardPropsSchema
    },
    Checklist: {
      component: GenerativeChecklist,
      description:
        "A checklist that the user can edit: a box for each item, and an optional notes field. The app adds a "
        + "\"Use in reply\" button that puts the current values in the message box as a draft. The user sends it. "
        + `items: 1 to ${CHECKLIST_LIMITS.items} objects { id, label, description? }. Each id is unique, starts with a `
        + `letter or digit, and holds only letters, digits, "-" and "_" (at most ${CHECKLIST_LIMITS.idChars} characters). `
        + `label: at most ${CHECKLIST_LIMITS.labelChars} characters. description: at most ${CHECKLIST_LIMITS.descriptionChars}. `
        + `title: optional, at most ${CHECKLIST_LIMITS.titleChars} characters. `
        + "Always bind checked to a data model path, for example \"checked\": {\"@path\": \"/release/checked\"}, and set "
        + "the start values at that path in the dataModel of createSurface: an object of item id to true or false. "
        + "An item that the object leaves out starts unchecked. A key that is not an item id makes the props invalid. "
        + "For a notes field, bind notes the same way, for example \"notes\": {\"@path\": \"/release/notes\"}, and set "
        + `a start text at that path, "" for an empty field (at most ${CHECKLIST_LIMITS.notesChars} characters). `
        + "Leave notes out for no notes field. A literal checked or notes value makes the checklist read-only: the "
        + "user's changes are not kept and do not reach you. Give each checklist its own paths. Later messages show "
        + "what the user changed in userValues, by path.",
      props: ChecklistPropsSchema,
      writable: ["checked", "notes"]
    },
    ComparisonTable: {
      component: GenerativeComparisonTable,
      description:
        "A read-only table that compares items across criteria. Use it when the user asks you to compare options. "
        + "It shows only the values that you give. It adds no ranking, score or highlight, and it has no buttons, "
        + `links or inputs. title: at most ${COMPARISON_TABLE_LIMITS.titleChars} characters, the caption. Always set it, `
        + `and name what is compared. columns: ${COMPARISON_TABLE_LIMITS.minColumns} to ${COMPARISON_TABLE_LIMITS.columns} objects { id, label }, the items `
        + `that you compare. rows: 1 to ${COMPARISON_TABLE_LIMITS.rows} objects { id, label, cells }, the criteria. `
        + `cells: an object of column id to a value: a text of at most ${COMPARISON_TABLE_LIMITS.cellChars} characters, `
        + "a number, true, false, or null. Put a unit in a text, such as \"$12/mo\". Never invent a value: use null, "
        + "or leave the column id out of cells, and the table shows \"No data\". A key of cells that is not a column id "
        + `makes the props invalid. Column ids are unique, and row ids are unique. An id starts with a letter or `
        + `digit and holds only letters, digits, "-" and "_" (at most ${CHECKLIST_LIMITS.idChars} characters). `
        + `label: at most ${COMPARISON_TABLE_LIMITS.labelChars} characters. A number is between -1e15 and 1e15. `
        + "Example: {\"title\": \"Plans\", \"columns\": [{\"id\": \"basic\", \"label\": \"Basic\"}, "
        + "{\"id\": \"pro\", \"label\": \"Pro\"}], \"rows\": [{\"id\": \"price\", \"label\": \"Price\", "
        + "\"cells\": {\"basic\": \"$9/mo\", \"pro\": \"$29/mo\"}}, {\"id\": \"sso\", \"label\": \"SSO\", "
        + "\"cells\": {\"basic\": false, \"pro\": null}}]}.",
      props: ComparisonTablePropsSchema
    },
    StatusSummary: {
      component: GenerativeStatusSummary,
      description:
        "A read-only status view of a project or a work list: a row for each phase or item, with a status label, "
        + "an optional detail line, and optional counts. Use it when the user asks for the status or the progress of "
        + `something. It has no buttons, links or inputs. title: at most ${STATUS_SUMMARY_LIMITS.titleChars} characters. `
        + `Always set it. items: 0 to ${STATUS_SUMMARY_LIMITS.items} objects { id, label, status?, detail?, completed?, total? }. `
        + `status is one of ${STATUS_SUMMARY_STATUSES.map((status) => `"${status}"`).join(", ")}. Leave status out when you `
        + "do not know it: the row then says \"Status not reported\". The app colors a status by its name only, so "
        + "put a reason in detail, never in status. "
        + `label: at most ${STATUS_SUMMARY_LIMITS.labelChars} characters. detail: at most ${STATUS_SUMMARY_LIMITS.detailChars}. `
        + "completed and total: whole numbers from your data, completed at most total, set together or not at all. "
        + "A row with a total above 0 gets a progress bar. Never estimate or compute a count. Set completed and total "
        + "at the top level only when your data gives a count for the whole view. Do not add up the rows. "
        + "Use the title to name what the whole-view count measures. An empty items array shows that there is nothing to show. "
        + `Each id is unique, starts with a letter or digit, and holds only letters, digits, "-" and "_" (at most `
        + `${CHECKLIST_LIMITS.idChars} characters). `
        + "Example: {\"title\": \"Release 4.2\", \"items\": [{\"id\": \"build\", \"label\": \"Build\", "
        + "\"status\": \"in-progress\", \"detail\": \"Waiting on the API team\", \"completed\": 3, \"total\": 8}, "
        + "{\"id\": \"launch\", \"label\": \"Launch\", \"status\": \"not-started\"}]}.",
      props: StatusSummaryPropsSchema
    }
  }
});

// SDK 1.83 overrides replace only the renderer. Update the new app catalog's
// description records too, without changing standardUI or any saved schema.
for (const [name, description] of Object.entries(SAFE_DESCRIPTIONS)) {
  COGNIPLANE_GENERATIVE_UI.components.get(name)!.description = description;
  COGNIPLANE_GENERATIVE_UI.manifestComponents[name]!.description = description;
}

// Activity surfaces render in either mode. Keep markdown for saved fences;
// the browser agent builds the tool guide from the envelope instead of context entries.
export const GENERATIVE_UI_CONFIG = { ui: COGNIPLANE_GENERATIVE_UI, transport: "markdown", sendContext: false } as const;
