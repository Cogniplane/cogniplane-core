"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

export type FileSourceConnectionState =
  | { kind: "connected"; label: string }
  | { kind: "disconnected"; label: string; settingsHref: string };

export type FileSourceSummary = {
  id: string;
  label: string;
  description: string;
  connection: FileSourceConnectionState;
};

export type FileSourceDefinition = FileSourceSummary & {
  renderBody: (context: { selectedSessionId: string | null }) => ReactNode;
};

function NotConnected(props: { source: FileSourceDefinition }) {
  if (props.source.connection.kind === "connected") return null;
  return (
    <div className="flex flex-col items-center gap-3 rounded-md bg-surface-container-low px-6 py-12 text-center">
      <p className="text-sm font-semibold text-on-surface">{props.source.label} not connected</p>
      <p className="text-sm text-on-surface-variant">{props.source.connection.label}</p>
      <Button asChild variant="outline" size="sm">
        <a href={props.source.connection.settingsHref}>
          Open {props.source.label} settings
        </a>
      </Button>
    </div>
  );
}

export function FileSourcePicker(props: {
  isOpen: boolean;
  onClose: () => void;
  selectedSessionId: string | null;
  sources: FileSourceDefinition[];
  activeSourceId: string | null;
  onSelectSource: (sourceId: string) => void;
}) {
  const { isOpen, onClose, sources, activeSourceId, onSelectSource } = props;

  const activeSourceFromList = sources.find((entry) => entry.id === activeSourceId) ?? sources[0] ?? null;
  const tabValue = activeSourceFromList?.id ?? "";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-outline-variant px-6 py-4">
          <p className="text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint">
            Add source
          </p>
          <DialogTitle>Pick a connected source, then add files to this session</DialogTitle>
          <DialogDescription>
            Files you add here become deterministic context for every turn until you remove them.
          </DialogDescription>
        </DialogHeader>

        {sources.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-12 text-center">
            <div>
              <p className="text-sm font-semibold text-on-surface">No sources available</p>
              <p className="text-sm text-on-surface-variant">
                Ask an administrator to enable an integration, or upload files directly.
              </p>
            </div>
          </div>
        ) : sources.length === 1 && activeSourceFromList ? (
          <div className="flex-1 overflow-auto p-6">
            {activeSourceFromList.connection.kind === "connected" ? (
              activeSourceFromList.renderBody({ selectedSessionId: props.selectedSessionId })
            ) : (
              <NotConnected source={activeSourceFromList} />
            )}
          </div>
        ) : (
          <Tabs
            value={tabValue}
            onValueChange={onSelectSource}
            className="flex flex-1 flex-col gap-0 overflow-hidden"
          >
            <TabsList className="mx-6 mt-4 grid w-auto grid-flow-col auto-cols-fr">
              {sources.map((source) => (
                <TabsTrigger key={source.id} value={source.id} className="flex-col items-start py-2">
                  <span>{source.label}</span>
                  <small className="text-[0.62rem] text-muted-foreground">
                    {source.connection.kind === "connected"
                      ? source.connection.label
                      : "Not connected"}
                  </small>
                </TabsTrigger>
              ))}
            </TabsList>

            {sources.map((source) => (
              <TabsContent
                key={source.id}
                value={source.id}
                className="flex-1 overflow-auto p-6 data-[state=inactive]:hidden"
              >
                {source.connection.kind === "connected" ? (
                  source.renderBody({ selectedSessionId: props.selectedSessionId })
                ) : (
                  <NotConnected source={source} />
                )}
              </TabsContent>
            ))}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
