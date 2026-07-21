import type { ReactNode } from "react";

// Template (not layout): remounts on every /admin/* navigation, replaying the
// entrance animation on the section content while the sidebar + header
// (rendered by layout.tsx) stay put.
export default function AdminTemplate({ children }: { children: ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
