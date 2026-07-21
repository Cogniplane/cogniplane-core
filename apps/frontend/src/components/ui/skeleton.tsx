import { cn } from "@/lib/cn";

// Loading placeholder. Size it with width/height utilities at the call site so
// the skeleton mirrors the shape of the content it stands in for — matching
// shapes are what make the swap read as "faster", not the shimmer itself.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-md bg-surface-container motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  );
}

export { Skeleton };
