"use client";

import { useEffect } from "react";

// Full-screen overlay that shows a single image at its natural size (capped to
// the viewport). Closes on Escape, on backdrop click, or via the close button.
// Inspired by t3code's ExpandedImageDialog, trimmed to the single-image case
// since Cogniplane chat images aren't part of a navigable gallery.
export function ImageLightbox({
  src,
  alt,
  onClose
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Image preview"}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image preview"
        className="absolute right-4 top-4 rounded-md bg-black/40 px-3 py-1.5 text-sm font-medium text-white outline-none hover:bg-black/60"
      >
        Close
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onClick={(event) => event.stopPropagation()}
        className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
      />
    </div>
  );
}
