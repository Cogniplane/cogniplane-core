"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, FolderIcon, PlusIcon } from "lucide-react";
import { AuthGuard } from "@/lib/auth-guard";
import { useAuth } from "@/lib/auth-context";
import { createProject, listProjects } from "@/lib/project-api";
import { ConsolePageHeader } from "@/components/console-page-header";
import { ProjectWorkspace } from "@/components/project-workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProjectsPage() {
  return (
    <AuthGuard>
      <Suspense
        fallback={
          <p role="status" className="p-6">
            Loading projects...
          </p>
        }
      >
        <Projects />
      </Suspense>
    </AuthGuard>
  );
}
function Projects() {
  const { user } = useAuth();
  const client = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("project");
  const selectProject = (id: string) =>
    router.replace(`/projects?project=${encodeURIComponent(id)}`);
  const [archived, setArchived] = useState(searchParams.get("archived") === "true");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const [name, setName] = useState("");
  const projects = useQuery({
    queryKey: ["projects", "list", archived, debouncedSearch],
    queryFn: () => listProjects({ archived, q: debouncedSearch }),
    placeholderData: keepPreviousData,
    enabled: Boolean(user)
  });
  const selected =
    projects.data?.find((project) => project.projectId === selectedId) ?? projects.data?.[0];
  const create = useMutation({
    mutationFn: () => createProject(name.trim()),
    onSuccess: async (project) => {
      setName("");
      setArchived(false);
      setSearch("");
      setDebouncedSearch("");
      selectProject(project.projectId);
      await client.invalidateQueries({ queryKey: ["projects"] });
    }
  });
  return (
    <main className="min-h-screen bg-background">
      <ConsolePageHeader
        eyebrow="Workspace"
        title="Projects"
        subtitle="Keep related conversations, reference files, and outputs together. Your projects are private to you."
        menuLinks={[{ href: "/", label: "Chat", description: "Return to the active workspace" }]}
      />
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
        <Button asChild variant="ghost" className="mb-5">
          <Link href="/">
            <ArrowLeftIcon />
            Back to chat
          </Link>
        </Button>
        <div className="grid gap-8 md:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="space-y-5">
            <div className="space-y-3">
              <div className="flex gap-2" aria-label="Project archive filter">
                <Button
                  size="sm"
                  variant={archived ? "ghost" : "secondary"}
                  aria-pressed={!archived}
                  onClick={() => setArchived(false)}
                >
                  Active
                </Button>
                <Button
                  size="sm"
                  variant={archived ? "secondary" : "ghost"}
                  aria-pressed={archived}
                  onClick={() => setArchived(true)}
                >
                  Archived
                </Button>
              </div>
              <label htmlFor="project-search" className="text-sm font-medium">
                Search projects and file names
              </label>
              <Input
                id="project-search"
                type="search"
                maxLength={200}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) create.mutate();
              }}
            >
              <label htmlFor="project-name" className="text-sm font-medium">
                New project
              </label>
              <Input
                id="project-name"
                placeholder="e.g. Quarterly planning"
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
                <PlusIcon />
                {create.isPending ? "Creating..." : "Create project"}
              </Button>
            </form>
            {create.isError ? (
              <p role="alert" className="text-sm text-danger">
                {create.error.message}
              </p>
            ) : null}
            {projects.isPending ? (
              <div aria-label="Loading projects" className="space-y-2">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : null}
            {projects.isError ? (
              <div role="alert" className="space-y-2 text-sm text-danger">
                <p>Could not load projects.</p>
                <Button variant="outline" onClick={() => void projects.refetch()}>
                  Try again
                </Button>
              </div>
            ) : null}
            <nav aria-label="Projects" className="flex flex-col gap-1">
              {projects.data?.map((project) => (
                <Button
                  key={project.projectId}
                  variant="ghost"
                  aria-current={selected?.projectId === project.projectId ? "page" : undefined}
                  className={`justify-start ${selected?.projectId === project.projectId ? "bg-brand-surface text-brand-strong" : ""}`}
                  onClick={() => selectProject(project.projectId)}
                >
                  <FolderIcon className="shrink-0" />
                  <span className="truncate">{project.name}</span>
                </Button>
              ))}
            </nav>
          </aside>
          {selected ? (
            <ProjectWorkspace key={selected.projectId} project={selected} />
          ) : projects.isSuccess ? (
            <section className="py-14 md:px-8">
              <FolderIcon className="mb-4 size-8 text-on-surface-variant" />
              <h2 className="text-xl font-semibold">
                {search
                  ? "No matching projects"
                  : archived
                    ? "No archived projects"
                    : "Give ongoing work a home"}
              </h2>
              <p className="mt-3 max-w-lg text-sm leading-6 text-on-surface-variant">
                {search
                  ? "Try another project or file name, or switch between Active and Archived."
                  : archived
                    ? "Archived projects appear here. Restore one to return its sessions to the main screen."
                    : "Create a project, add related sessions, and keep reference files for your next conversation."}
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
