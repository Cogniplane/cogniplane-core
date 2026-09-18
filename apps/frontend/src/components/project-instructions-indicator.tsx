"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { getProjectInstructionsStatus } from "@/lib/project-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "./ui/button";

export function ProjectInstructionsIndicator({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: queryKeys.projects.instructionsStatus(projectId),
    queryFn: () => getProjectInstructionsStatus(projectId),
    refetchOnWindowFocus: "always"
  });
  return <Button asChild size="sm" variant="ghost">
    <Link href={`/projects?project=${encodeURIComponent(projectId)}`}
      title={project.isError ? "Could not load project instructions. Open the project to retry."
        : project.data?.hasInstructions ? "Project instructions apply when each turn starts. Changes take effect on the next turn."
        : "Open project"}>
      {project.isError ? "Project context unavailable" : project.data?.hasInstructions ? "Project instructions" : "Project"}
    </Link>
  </Button>;
}
