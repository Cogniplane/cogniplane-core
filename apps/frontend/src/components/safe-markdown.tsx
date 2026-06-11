"use client";

import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";

import { ImageLightbox } from "./image-lightbox";

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

export function SafeMarkdown({ children }: { children: string }) {
  // Lightbox target: the src/alt of the inline image the user clicked, or null.
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);

  const components: Components = {
    img: ({ src, alt }) => {
      if (typeof src !== "string" || src.length === 0) return null;
      const altText = alt ?? "";
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
  };

  return (
    <>
      <ReactMarkdown allowedElements={ALLOWED_ELEMENTS} unwrapDisallowed components={components}>
        {children}
      </ReactMarkdown>
      {zoomed ? (
        <ImageLightbox src={zoomed.src} alt={zoomed.alt} onClose={() => setZoomed(null)} />
      ) : null}
    </>
  );
}
