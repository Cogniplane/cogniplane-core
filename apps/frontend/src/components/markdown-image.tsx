"use client";

import { useState } from "react";

import { ImageLightbox } from "./image-lightbox";
import { describeImageHost, isTrustedImageSource } from "./safe-markdown.logic";

// The image renderer shared by every markdown surface: our own SafeMarkdown and
// CopilotChat's built-in renderer, which sanitizes with rehype's default schema
// and therefore permits a bare <img> the CSP then blocks.
//
// It owns its own lightbox state so a caller only has to hand it a src and alt.
export function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const [zoomed, setZoomed] = useState(false);

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
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={altText}
        onClick={() => setZoomed(true)}
        className="cursor-zoom-in rounded-md"
      />
      {zoomed ? (
        <ImageLightbox src={src} alt={altText} onClose={() => setZoomed(false)} />
      ) : null}
    </>
  );
}
