"use client";

import { useState } from "react";

import type { MicrosoftFile, MicrosoftSite } from "../../../sharepoint-overlay-contracts/src/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Tab = "search" | "browse";

const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

function formatFileSize(size: number | null): string {
  if (size == null) return "Unknown size";
  if (size < 1024) return `${size}\u00a0B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}\u00a0KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}\u00a0MB`;
}

function formatFileMeta(file: MicrosoftFile): string {
  const kind = file.isFolder ? "Folder" : file.mimeType ?? "File";
  const path = file.path?.replace(/^\/drive\/root:/, "") ?? null;
  return [kind, formatFileSize(file.size), path].filter(Boolean).join(" · ");
}

function SourceBadge(props: { file: MicrosoftFile }) {
  const isOneDrive = props.file.source === "onedrive";
  return (
    <span
      className={`${PILL_BASE} ${
        isOneDrive
          ? "bg-info-surface text-info"
          : "bg-surface-container text-on-surface-variant"
      }`}
    >
      {isOneDrive ? "OneDrive" : "SharePoint"}
    </span>
  );
}

function EmptyPanel(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md bg-surface-container-low px-6 py-12 text-center">
      <strong className="text-sm font-semibold text-on-surface">{props.title}</strong>
      <p className="text-sm text-on-surface-variant">{props.children}</p>
    </div>
  );
}

function FileActionRow(props: {
  file: MicrosoftFile;
  canImport: boolean;
  importingItemId: string | null;
  onOpenFolder: (file: MicrosoftFile) => void;
  onImport: (file: MicrosoftFile) => void;
}) {
  const { file, canImport, importingItemId, onOpenFolder, onImport } = props;

  return (
    <article
      className="flex flex-wrap items-start gap-3 rounded-md border border-outline-variant bg-surface-bright px-3 py-2.5"
    >
      <div className="flex min-w-0 max-w-full flex-col gap-0.5" style={{ flex: "1 1 16rem" }}>
        <div className="flex flex-wrap items-center gap-2">
          <strong className="min-w-0 max-w-full break-words text-sm font-semibold text-on-surface" title={file.name}>
            {file.name}
          </strong>
          <SourceBadge file={file} />
        </div>
        <p className="break-words text-xs text-on-surface-variant [overflow-wrap:anywhere]">{formatFileMeta(file)}</p>
        {file.summary ? (
          <p className="break-words text-xs text-on-surface-faint">{file.summary}</p>
        ) : null}
      </div>
      <div className="flex max-w-full flex-wrap items-center justify-end gap-2" style={{ marginLeft: "auto" }}>
        {file.isFolder ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenFolder(file)}>
            Open folder
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={!canImport || importingItemId === file.itemId}
            onClick={() => onImport(file)}
          >
            {importingItemId === file.itemId ? "Importing..." : "Add to session"}
          </Button>
        )}
        {file.webUrl ? (
          <Button asChild variant="ghost" size="sm">
            <a href={file.webUrl} rel="noreferrer" target="_blank">
              Open in Microsoft
            </a>
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export type MicrosoftFileSourceBodyProps = {
  selectedSessionId: string | null;
  sites: MicrosoftSite[];
  siteSearch: string;
  setSiteSearch: (value: string) => void;
  isLoadingSites: boolean;
  refreshSites: () => void;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  searchResults: MicrosoftFile[];
  isSearching: boolean;
  runSearch: () => void;
  browseStack: Array<{ label: string }>;
  browseItems: MicrosoftFile[];
  isLoadingBrowse: boolean;
  openOneDriveRoot: () => void;
  openSite: (site: MicrosoftSite) => void;
  openFolder: (file: MicrosoftFile) => void;
  navigateToBreadcrumb: (index: number) => void;
  importFile: (file: MicrosoftFile) => void;
  importingItemId: string | null;
};

export function MicrosoftFileSourceBody(props: MicrosoftFileSourceBodyProps) {
  const [activeTab, setActiveTab] = useState<Tab>("search");

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as Tab)}
      className="flex flex-col gap-4"
    >
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="search">Search</TabsTrigger>
        <TabsTrigger value="browse">Browse</TabsTrigger>
      </TabsList>

      <TabsContent value="search" className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Input
            disabled={!props.selectedSessionId}
            onChange={(event) => props.setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void props.runSearch();
              }
            }}
            placeholder="Search by file name, folder, or topic"
            type="search"
            value={props.searchQuery}
          />
          <Button
            type="button"
            disabled={!props.selectedSessionId || props.isSearching}
            onClick={() => void props.runSearch()}
          >
            {props.isSearching ? "Searching..." : "Search"}
          </Button>
        </div>

        {props.searchResults.length ? (
          <div className="flex flex-col gap-2">
            {props.searchResults.map((file) => (
              <FileActionRow
                canImport={Boolean(props.selectedSessionId)}
                file={file}
                importingItemId={props.importingItemId}
                key={`${file.driveId}:${file.itemId}`}
                onImport={props.importFile}
                onOpenFolder={(folder) => {
                  setActiveTab("browse");
                  void props.openFolder(folder);
                }}
              />
            ))}
          </div>
        ) : (
          <EmptyPanel title="Search your Microsoft documents">
            Type a title, year, client, or keyword to find the right file before adding it to
            chat context.
          </EmptyPanel>
        )}
      </TabsContent>

      <TabsContent
        value="browse"
        className="grid grid-cols-1 gap-4 md:grid-cols-[220px_minmax(0,1fr)]"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Input
              onChange={(event) => props.setSiteSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void props.refreshSites();
                }
              }}
              placeholder="Filter SharePoint sites"
              type="search"
              value={props.siteSearch}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={props.isLoadingSites}
              onClick={() => void props.refreshSites()}
            >
              {props.isLoadingSites ? "Loading..." : "Load"}
            </Button>
          </div>

          <div className="flex flex-col gap-1">
            <button
              type="button"
              className="rounded-md border border-outline-variant bg-surface-bright px-3 py-2 text-left text-sm font-medium text-on-surface hover:bg-accent"
              onClick={() => void props.openOneDriveRoot()}
            >
              OneDrive
            </button>
            {props.sites.map((site) => (
              <button
                type="button"
                key={site.siteId}
                className="flex flex-col rounded-md border border-outline-variant bg-surface-bright px-3 py-2 text-left hover:bg-accent"
                onClick={() => void props.openSite(site)}
              >
                <span className="text-sm font-medium text-on-surface">
                  {site.displayName ?? site.name ?? "SharePoint site"}
                </span>
                {site.webUrl ? (
                  <small className="text-xs text-on-surface-faint">
                    {site.webUrl.replace(/^https?:\/\//, "")}
                  </small>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint">
              Current folder
            </p>
            <div className="flex flex-wrap items-center gap-1">
              {props.browseStack.map((location, index) => (
                <button
                  type="button"
                  key={`${location.label}-${index}`}
                  className="text-sm text-on-surface-variant hover:text-on-surface hover:underline"
                  onClick={() => void props.navigateToBreadcrumb(index)}
                >
                  {index > 0 ? <span className="mr-1 text-on-surface-faint">/</span> : null}
                  {location.label}
                </button>
              ))}
            </div>
          </div>

          {props.isLoadingBrowse ? (
            <EmptyPanel title="Loading files">
              Fetching the current folder from OneDrive or SharePoint.
            </EmptyPanel>
          ) : props.browseItems.length ? (
            <div className="flex flex-col gap-2">
              {props.browseItems.map((file) => (
                <FileActionRow
                  canImport={Boolean(props.selectedSessionId)}
                  file={file}
                  importingItemId={props.importingItemId}
                  key={`${file.driveId}:${file.itemId}`}
                  onImport={props.importFile}
                  onOpenFolder={props.openFolder}
                />
              ))}
            </div>
          ) : (
            <EmptyPanel title="No files in this view">
              Open another folder or switch back to search when you know the document name.
            </EmptyPanel>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
