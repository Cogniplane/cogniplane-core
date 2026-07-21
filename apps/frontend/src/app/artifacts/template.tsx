import type { ReactNode } from "react";

// Template: replays the entrance animation when navigating to /artifacts.
export default function ArtifactsTemplate({ children }: { children: ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
