"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { getProjectInstructionsStatus } from "@/lib/project-api";
import { queryKeys } from "@/lib/query-keys";
import { FolderOpenIcon } from "lucide-react";
import { Button } from "./ui/button";

/** `compact` shows only an icon, with the same text as its accessible name. */
export function ProjectInstructionsIndicator({ projectId, compact = false, className }: { projectId: string; compact?: boolean; className?: string }) {
  const project = useQuery({
    queryKey: queryKeys.projects.instructionsStatus(projectId),
    queryFn: () => getProjectInstructionsStatus(projectId),
    refetchOnWindowFocus: "always"
  });
  const label = project.isError ? "Project context unavailable" : project.data?.hasInstructions ? "Project instructions" : "Project";
  return <Button asChild size={compact ? "icon-sm" : "sm"} variant="ghost" className={className}>
    <Link href={`/projects?project=${encodeURIComponent(projectId)}`}
      aria-label={compact ? label : undefined}
      title={project.isError ? "Could not load project instructions. Open the project to retry."
        : project.data?.hasInstructions ? "Project instructions apply when each turn starts. Changes take effect on the next turn."
        : "Open project"}>
      {compact ? <FolderOpenIcon aria-hidden="true" className={project.isError ? "text-danger" : undefined} /> : label}
    </Link>
  </Button>;
}
