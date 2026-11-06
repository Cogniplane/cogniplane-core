"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, FolderIcon, PlusIcon } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { createProject, getProject, listProjects } from "@/lib/project-api";
import { ConsolePageHeader } from "@/components/console-page-header";
import { ProjectWorkspace } from "@/components/project-workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function Projects() {
  const { user } = useAuth();
  const client = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("project");
  const selectedView = searchParams.get("view") === "settings" ? "settings" : "overview";
  const archived = searchParams.get("archived") === "true";
  const [browserOpen, setBrowserOpen] = useState(false);
  const projectHref = (id: string, archiveScope = archived) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("project", id);
    params.delete("view");
    params.set("archived", String(archiveScope));
    return `/projects?${params}`;
  };
  const selectProject = (id: string, archiveScope = archived) => {
    router.push(projectHref(id, archiveScope));
    setBrowserOpen(false);
  };
  const setArchived = (value: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("archived", String(value));
    router.push(`/projects?${params}`, { scroll: false });
  };
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
  const firstProjectId = projects.data?.[0]?.projectId;
  useEffect(() => {
    if (!selectedId && firstProjectId) {
      const params = new URLSearchParams(searchParams.toString());
      params.set("project", firstProjectId);
      params.set("archived", String(archived));
      router.replace(`/projects?${params}`, { scroll: false });
    }
  }, [selectedId, firstProjectId, searchParams, archived, router]);
  const selection = useQuery({
    queryKey: ["projects", selectedId],
    queryFn: () => getProject(selectedId!),
    enabled: Boolean(user && selectedId)
  });
  const selected = selectedId
    ? selection.data?.project ?? projects.data?.find((project) => project.projectId === selectedId)
    : projects.data?.[0];
  const selectedOutsideList = selected && projects.isSuccess && !projects.isPlaceholderData &&
    !projects.data.some((project) => project.projectId === selected.projectId);
  const create = useMutation({
    mutationFn: () => createProject(name.trim()),
    onSuccess: async (project) => {
      setName("");
      setSearch("");
      setDebouncedSearch("");
      selectProject(project.projectId, false);
      setBrowserOpen(false);
      await client.invalidateQueries({ queryKey: ["projects"] });
    }
  });
  const projectBrowser = (prefix: string) => (
    <div className="min-w-0 space-y-5">
      <div className="space-y-3">
        <div className="flex gap-2" role="group" aria-label="Project archive filter">
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
        <label htmlFor={`${prefix}-project-search`} className="text-sm font-medium">
          Search projects and file names
        </label>
        <Input
          id={`${prefix}-project-search`}
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
          if (name.trim() && !create.isPending) create.mutate();
        }}
      >
        <label htmlFor={`${prefix}-project-name`} className="text-sm font-medium">
          New project
        </label>
        <Input
          id={`${prefix}-project-name`}
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
            className={`h-auto min-h-10 justify-start py-2 text-left whitespace-normal ${selected?.projectId === project.projectId ? "bg-brand-surface text-brand-strong" : ""}`}
            onClick={() => selectProject(project.projectId)}
          >
            <FolderIcon className="shrink-0" />
            <span className="min-w-0 break-words">{project.name}</span>
          </Button>
        ))}
      </nav>
      {projects.isSuccess && projects.data.length === 0 ? <div role="status" className="space-y-2 text-sm text-on-surface-variant">
        <p>{debouncedSearch ? "No matching projects." : archived ? "No archived projects." : "No active projects yet."}</p>
        {search ? <Button variant="outline" size="sm" onClick={() => { setSearch(""); setDebouncedSearch(""); }}>Clear search</Button> : null}
      </div> : null}
    </div>
  );
  return (
    <main className="min-h-screen bg-background">
      <ConsolePageHeader
        className="mx-auto max-w-7xl px-4 pt-4 md:px-8 md:pt-6"
        title="Projects"
        subtitle="Keep related conversations, reference files, and outputs together."
        destinations={["chat", "artifacts", "settings", "admin"]}
      />
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
        <Button asChild variant="ghost" className="mb-5">
          <Link href="/">
            <ArrowLeftIcon />
            Back to chat
          </Link>
        </Button>
        <div className="grid gap-8 md:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="hidden min-w-0 md:block">{projectBrowser("desktop")}</aside>
          <div className="min-w-0 md:hidden">
            <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
              <DialogTrigger asChild><Button variant="outline" className="w-full justify-start"><FolderIcon />Browse projects</Button></DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader><DialogTitle>Browse projects</DialogTitle><DialogDescription>Choose an active or archived project.</DialogDescription></DialogHeader>
                {projectBrowser("phone")}
              </DialogContent>
            </Dialog>
          </div>
          <div className="min-w-0">
            {selectedOutsideList ? <p role="status" className="mb-4 text-sm text-on-surface-variant">This project is outside the current {archived ? "Archived" : "Active"} list{debouncedSearch ? " and search results" : ""}. Your open work stays here.</p> : null}
            {selected ? (
              <ProjectWorkspace key={selected.projectId} project={selected} view={selectedView} archiveScope={archived} />
            ) : selectedId && selection.isPending ? (
              <p role="status">Loading selected project...</p>
            ) : selectedId && selection.isError ? (
              <section role="alert" className="space-y-3 py-8">
                <h2 className="text-xl font-semibold">Could not open this project</h2>
                <p className="text-sm text-on-surface-variant">It may be unavailable or your access may have changed. Choose a project from the list, or try again.</p>
                <Button variant="outline" onClick={() => void selection.refetch()}>Try selected project again</Button>
              </section>
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
      </div>
    </main>
  );
}
