"use client";

import { Suspense, lazy, memo } from "react";
import { type Components } from "react-markdown";

import { MarkdownImage } from "./markdown-image";
import { classifyMarkdownLink } from "./safe-markdown.logic";

// react-markdown pulls in the remark/rehype/micromark stack. Split it into its
// own chunk so it's not in the initial client bundle; it loads on first render.
// The Suspense fallback shows the raw text so streamed content is never blank
// during the (one-time, then cached) chunk fetch.
const ReactMarkdown = lazy(() => import("react-markdown"));

// Whitelist of HAST element names we render. Anything outside this set is
// dropped (including `script`/`iframe`/`object`/`embed`/`style`/`form`/etc.).
// Raw HTML in markdown is also ignored because we never attach `rehype-raw`.
// Keep this list conservative; agents render user-adjacent content here.
const ALLOWED_ELEMENTS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul"
];

// Fully static — no render-dependent state, so hoist it out of the component.
const LinkRenderer: NonNullable<Components["a"]> = ({ href, children }) => {
  const link = classifyMarkdownLink(href);
  return (
    <a
      href={href}
      target={link.opensExternally ? "_blank" : undefined}
      rel={link.opensExternally ? "noopener noreferrer" : undefined}
    >
      {children}
      {link.opensExternally && !link.isAllowlistedHost ? (
        <span className="ml-1 text-xs text-muted-foreground">[external: {link.host}]</span>
      ) : null}
    </a>
  );
};

// Both renderers are static, so the map is built once at module scope.
const COMPONENTS: Components = {
  a: LinkRenderer,
  img: MarkdownImage
};

function SafeMarkdownImpl({ children }: { children: string }) {
  return (
    <Suspense fallback={<span className="whitespace-pre-wrap">{children}</span>}>
      {/* .md-body picks up the shared rendered-markdown rules in globals.css
          (tables, blockquotes, links) that react-markdown emits unstyled. */}
      <div className="md-body">
        <ReactMarkdown allowedElements={ALLOWED_ELEMENTS} unwrapDisallowed components={COMPONENTS}>
          {children}
        </ReactMarkdown>
      </div>
    </Suspense>
  );
}

// Finished messages keep the same `children` string across streaming re-renders
// of the timeline, so memo lets them skip re-parsing on every token.
export const SafeMarkdown = memo(SafeMarkdownImpl);
