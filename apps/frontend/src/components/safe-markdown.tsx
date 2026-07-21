"use client";

import { Suspense, lazy, memo, useMemo, useState } from "react";
import { type Components } from "react-markdown";

import { ImageLightbox } from "./image-lightbox";
import {
  classifyMarkdownLink,
  describeImageHost,
  isTrustedImageSource
} from "./safe-markdown.logic";

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

function SafeMarkdownImpl({ children }: { children: string }) {
  // Lightbox target: the src/alt of the inline image the user clicked, or null.
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);

  // setZoomed is stable, so the map only needs building once per mount.
  const components = useMemo<Components>(
    () => ({
      a: LinkRenderer,
      img: ({ src, alt }) => {
        if (typeof src !== "string" || src.length === 0) return null;
        const altText = alt ?? "";
        if (!isTrustedImageSource(src)) {
          // External images never auto-fetch: rendering them would let a
          // prompt-injected agent exfiltrate data through the URL the moment the
          // message is displayed. Show a click-through link instead.
          return (
            <a href={src} target="_blank" rel="noopener noreferrer">
              [External image{altText ? `: ${altText}` : ""} ({describeImageHost(src)})]
            </a>
          );
        }
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={altText}
            onClick={() => setZoomed({ src, alt: altText })}
            className="cursor-zoom-in rounded-md"
          />
        );
      }
    }),
    []
  );

  return (
    <>
      <Suspense fallback={<span className="whitespace-pre-wrap">{children}</span>}>
        {/* .md-body picks up the shared rendered-markdown rules in globals.css
            (tables, blockquotes, links) that react-markdown emits unstyled. */}
        <div className="md-body">
          <ReactMarkdown allowedElements={ALLOWED_ELEMENTS} unwrapDisallowed components={components}>
            {children}
          </ReactMarkdown>
        </div>
      </Suspense>
      {zoomed ? (
        <ImageLightbox src={zoomed.src} alt={zoomed.alt} onClose={() => setZoomed(null)} />
      ) : null}
    </>
  );
}

// Finished messages keep the same `children` string across streaming re-renders
// of the timeline, so memo lets them skip re-parsing on every token.
export const SafeMarkdown = memo(SafeMarkdownImpl);
