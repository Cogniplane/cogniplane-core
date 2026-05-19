"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { AdminSessionAlertsTab } from "./admin-session-alerts-tab";
import { AdminSessionApprovalsTab } from "./admin-session-approvals-tab";
import { AdminSessionArtifactsTab } from "./admin-session-artifacts-tab";
import { AdminSessionAuditTab } from "./admin-session-audit-tab";
import { AdminSessionOverviewTab } from "./admin-session-overview-tab";
import { AdminSessionPiiTab } from "./admin-session-pii-tab";
import { AdminSessionRawTab } from "./admin-session-raw-tab";
import { AdminSessionToolsTab } from "./admin-session-tools-tab";
import type { AdminSessionDetailResponse } from "@cogniplane/shared-types";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";

export type SidebarTabId =
  | "overview"
  | "alerts"
  | "approvals"
  | "tools"
  | "artifacts"
  | "pii"
  | "audit"
  | "raw";

const TAB_DEFS: Array<{ id: SidebarTabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "alerts", label: "Alerts" },
  { id: "approvals", label: "Approvals" },
  { id: "tools", label: "Tools" },
  { id: "artifacts", label: "Artifacts" },
  { id: "pii", label: "PII" },
  { id: "audit", label: "Audit" },
  { id: "raw", label: "Raw" }
];

const VALID_TABS = new Set<SidebarTabId>(TAB_DEFS.map((t) => t.id));

function isSidebarTab(value: string | null): value is SidebarTabId {
  return value !== null && VALID_TABS.has(value as SidebarTabId);
}

export function AdminSessionDetailSidebar(props: { detail: AdminSessionDetailResponse }) {
  // Seed activeTab from ?tab=… so deep-links from the dashboard's recent
  // activity feed and top-offenders table land directly on the relevant
  // tab. We only read the param on mount; subsequent tab clicks live in
  // local state without rewriting the URL.
  const searchParams = useSearchParams();
  const initialTab = isSidebarTab(searchParams.get("tab"))
    ? (searchParams.get("tab") as SidebarTabId)
    : "overview";
  const [activeTab, setActiveTab] = useState<SidebarTabId>(initialTab);

  return (
    <Card>
      <CardHeader>
        <p className={SECTION_LABEL}>Investigation</p>
        <h2 className="text-lg font-semibold text-on-surface">
          {TAB_DEFS.find((t) => t.id === activeTab)?.label ?? "Tabs"}
        </h2>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as SidebarTabId)}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0">
            {TAB_DEFS.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id} className="rounded-full">
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="mt-4">
            <TabsContent value="overview" className="data-[state=inactive]:hidden">
              <AdminSessionOverviewTab overview={props.detail.overview} />
            </TabsContent>
            <TabsContent value="alerts" className="data-[state=inactive]:hidden">
              <AdminSessionAlertsTab
                messages={props.detail.messages}
                approvals={props.detail.approvals}
                piiRuns={props.detail.piiRuns}
              />
            </TabsContent>
            <TabsContent value="approvals" className="data-[state=inactive]:hidden">
              <AdminSessionApprovalsTab approvals={props.detail.approvals} />
            </TabsContent>
            <TabsContent value="tools" className="data-[state=inactive]:hidden">
              <AdminSessionToolsTab
                toolEvents={props.detail.toolEvents}
                messageToolResults={props.detail.messageToolResults}
              />
            </TabsContent>
            <TabsContent value="artifacts" className="data-[state=inactive]:hidden">
              <AdminSessionArtifactsTab artifacts={props.detail.artifacts} />
            </TabsContent>
            <TabsContent value="pii" className="data-[state=inactive]:hidden">
              <AdminSessionPiiTab piiRuns={props.detail.piiRuns} />
            </TabsContent>
            <TabsContent value="audit" className="data-[state=inactive]:hidden">
              <AdminSessionAuditTab auditEvents={props.detail.auditEvents} />
            </TabsContent>
            <TabsContent value="raw" className="data-[state=inactive]:hidden">
              <AdminSessionRawTab messages={props.detail.messages} />
            </TabsContent>
          </div>
        </Tabs>
      </CardContent>
    </Card>
  );
}
