"use client";

// Client-side overlay bootstrap. Rendered once from the root layout so
// every route hydrates with the same set of registered overlays — file
// sources, settings sections, etc.
//
// Why this exists: `overlays.ts` is a plain server-context module that
// chains into the SharePoint overlay's `register.tsx` (a `"use client"`
// module). When a server component side-effect-imports a `"use client"`
// module, Next.js bundles it but does not guarantee eager evaluation
// unless something from that boundary is actually rendered. Without an
// eager evaluation, `registerFileSource(...)` can fire mid-session when
// some other route (e.g. `/settings`) prefetches — which mutates the
// `factories` array `useFileSources` iterates with hooks, and React
// throws minified error #311.
//
// By importing the registrations from a "use client" module that the
// root layout renders, the client chunk is guaranteed to load and
// evaluate before any child component (notably `ChatShell`) renders, so
// `factories.length` is stable from the very first paint.

import "./overlays";

export function OverlayBootstrap(): null {
  return null;
}
