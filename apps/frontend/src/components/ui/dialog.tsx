import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/cn"
import { Button } from "@/components/ui/button"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  scrollBody = true,
  footer,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /** False when the caller owns its scrolling layout, as Quick Jump does. */
  scrollBody?: boolean
  /** Keeps decisions and their feedback outside the scrolling body. */
  footer?: React.ReactNode
}) {
  const opener = React.useRef<HTMLElement | null>(null)
  const [body, setBody] = React.useState<HTMLDivElement | null>(null)
  React.useLayoutEffect(() => {
    const container = body
    if (!container || typeof ResizeObserver === "undefined") return
    const revealFocus = () => {
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || !container.contains(active)) return
      const bounds = container.getBoundingClientRect()
      const target = active.getBoundingClientRect()
      if (target.top < bounds.top + 4 || target.bottom > bounds.bottom - 4) {
        active.scrollIntoView?.({ block: "nearest" })
      }
    }
    // Autofocus can precede the final body height. Keep the owned control
    // visible when the dialog opens, resizes, or gains feedback.
    const observer = new ResizeObserver(revealFocus)
    observer.observe(container)
    return () => observer.disconnect()
  }, [body])
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onOpenAutoFocus={(event) => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          onOpenAutoFocus?.(event)
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          // Programmatic dialogs may have no DialogTrigger. Keep the stable
          // opener instead of letting focus fall back to the page body.
          if (!event.defaultPrevented && opener.current?.isConnected && opener.current !== document.body) {
            event.preventDefault()
            opener.current.focus()
          }
        }}
        className={cn(
          "fixed top-[50%] left-[50%] z-50 max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden rounded-lg border bg-popover p-6 text-popover-foreground shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          scrollBody ? "flex flex-col" : "grid",
          className,
          // Reserve a fixed band above the scrolling body for Close.
          scrollBody && "pt-14"
        )}
        {...props}
      >
        {scrollBody ? (
          <div
            ref={setBody}
            data-slot="dialog-body"
            className="-m-1 min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-p-1 p-1"
            style={{ display: "inherit", flexDirection: "inherit", gap: "inherit", gridTemplateColumns: "inherit", gridTemplateRows: "inherit" }}
          >
            {children}
          </div>
        ) : children}
        {footer}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-3 right-3 z-10 inline-flex size-9 items-center justify-center rounded-md bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 pr-8 text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      // Sticky, so the decision stays reachable while a long dialog body scrolls.
      // The shadow paints the padding below it, so scrolled content does not show there.
      className={cn(
        "sticky bottom-0 flex flex-col-reverse gap-2 bg-popover pt-2 shadow-[0_1.5rem_0_0_var(--color-popover)] sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-snug font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
