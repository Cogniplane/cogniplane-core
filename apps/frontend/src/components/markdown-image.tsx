"use client";

import { useRef, useState } from "react";
import { ExpandIcon } from "lucide-react";

import { ImageLightbox } from "./image-lightbox";
import { describeImageHost, isLinkableImageSource, isTrustedImageSource } from "./safe-markdown.logic";

// The image renderer shared by every markdown surface: our own SafeMarkdown and
// CopilotChat's built-in renderer, which sanitizes with rehype's default schema
// and therefore permits a bare <img> the CSP then blocks.
//
// It owns its own lightbox state so a caller only has to hand it a src and alt.
// A trusted image is a button, so a keyboard user can open the lightbox too.
export function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const [zoomed, setZoomed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  if (typeof src !== "string" || src.length === 0) return null;
  const altText = alt ?? "";

  if (!isTrustedImageSource(src)) {
    // External images never auto-fetch: rendering them would let a
    // prompt-injected agent exfiltrate data through the URL the moment the
    // message is displayed. Show a click-through link instead, and plain text
    // for a URL that is not HTTP(S).
    const label = `[External image${altText ? `: ${altText}` : ""} (${describeImageHost(src)})]`;
    if (!isLinkableImageSource(src)) return <span data-markdown-image>{label}</span>;
    return (
      <a data-markdown-image href={src} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }

  return (
    <>
      <button
        data-markdown-image
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-label={altText ? `Enlarge image: ${altText}` : "Enlarge image"}
        onClick={() => setZoomed(true)}
        className="inline-flex max-w-full cursor-zoom-in flex-col items-end gap-1 rounded-md align-top outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={altText} className="rounded-md" />
        <span aria-hidden="true" className="@container flex w-full justify-end">
          <span className="flex max-w-full items-center gap-1 rounded-md border border-outline-variant bg-popover px-2 py-1 text-xs font-medium text-popover-foreground">
            <ExpandIcon className="size-3 shrink-0" /><span className="hidden @[80px]:inline">Enlarge</span>
          </span>
        </span>
      </button>
      <ImageLightbox
        src={src}
        alt={altText}
        open={zoomed}
        onOpenChange={setZoomed}
        onCloseAutoFocus={(event) => {
          // Safari does not focus a clicked button, so return to it by ref.
          if (!triggerRef.current?.isConnected) return;
          event.preventDefault();
          triggerRef.current.focus();
        }}
      />
    </>
  );
}
