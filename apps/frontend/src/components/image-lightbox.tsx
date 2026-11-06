"use client";

import type { ComponentProps } from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

// One image at its natural size, capped to the viewport. It uses the shared
// dialog, so it has the portal, the focus trap, the theme layers and the modal
// z-index of every other dialog. The dialog takes Escape in the capture phase
// and marks it as handled, so Escape closes only this layer: the panel under
// it stays open and the Stop shortcut leaves the key alone.
export function ImageLightbox({
  src,
  alt,
  open,
  onOpenChange,
  onCloseAutoFocus
}: {
  src: string;
  alt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Gives the focus back to the control that opened the image. */
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        scrollBody={false}
        aria-describedby={undefined}
        onCloseAutoFocus={onCloseAutoFocus}
        className="left-4 right-4 mx-auto flex max-h-[calc(100dvh-2rem)] w-fit min-w-[min(20rem,calc(100%-2rem))] translate-x-0 flex-col gap-0 p-0 sm:max-w-[min(72rem,calc(100%-2rem))]"
      >
        <DialogHeader className="shrink-0 border-b border-outline-variant px-6 py-4 pr-14">
          <DialogTitle className="truncate text-base">{alt || "Image"}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-container-low p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className="max-h-[calc(100dvh-8rem)] max-w-full rounded-md object-contain"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
