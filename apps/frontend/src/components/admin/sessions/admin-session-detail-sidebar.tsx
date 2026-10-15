"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { AdminChatReplay } from "./admin-chat-replay";
import { AdminSessionAlertsTab } from "./admin-session-alerts-tab";
import { AdminSessionApprovalsTab } from "./admin-session-approvals-tab";
import { AdminSessionArtifactsTab } from "./admin-session-artifacts-tab";
import { AdminSessionAuditTab } from "./admin-session-audit-tab";
import { AdminSessionOverviewTab } from "./admin-session-overview-tab";
import { AdminSessionPiiTab } from "./admin-session-pii-tab";
import { AdminSessionRawTab } from "./admin-session-raw-tab";
import { AdminSessionResourcesCard } from "./admin-session-resources-card";
import { AdminSessionToolsTab } from "./admin-session-tools-tab";
import type { AdminSessionDetailResponse } from "@cogniplane/shared-types";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type SidebarTabId = "conversation" | "alerts" | "approvals" | "overview" | "tools" | "artifacts" | "pii" | "audit" | "raw";

const DIAGNOSTICS = [
  { id: "overview", label: "Session details" },
  { id: "tools", label: "Tool calls" },
  { id: "artifacts", label: "Files" },
  { id: "pii", label: "Privacy scans" },
  { id: "audit", label: "Audit events" },
  { id: "raw", label: "Raw messages" }
] as const;
const VALID_TABS = new Set<string>(["conversation", "alerts", "approvals", ...DIAGNOSTICS.map((tab) => tab.id)]);

export function AdminSessionDetailSidebar(props: { detail: AdminSessionDetailResponse }) {
  const searchParams = useSearchParams();
  const requested = searchParams.get("tab");
  // Preserve existing links to diagnostic tabs. Ordinary visits open the conversation.
  const [activeTab, setActiveTab] = useState<SidebarTabId>(
    requested && VALID_TABS.has(requested) ? requested as SidebarTabId : "conversation"
  );
  const isDiagnostic = DIAGNOSTICS.some((tab) => tab.id === activeTab);
  const { detail } = props;

  return (
    <>
      <Card>
        <CardContent className="pt-5">
          <Tabs value={isDiagnostic ? "diagnostics" : activeTab} onValueChange={(value) => setActiveTab(value === "diagnostics" ? "overview" : value as SidebarTabId)}>
            <TabsList aria-label="Session investigation" className="flex h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0">
              <TabsTrigger value="conversation">Conversation</TabsTrigger>
              <TabsTrigger value="alerts">Alerts</TabsTrigger>
              <TabsTrigger value="approvals">Approvals</TabsTrigger>
              <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
            </TabsList>
            <div className="mt-4 min-w-0">
              <TabsContent value="conversation" className="data-[state=inactive]:hidden">
                <AdminChatReplay messages={detail.messages} piiRuns={detail.piiRuns} />
              </TabsContent>
              <TabsContent value="alerts" className="data-[state=inactive]:hidden">
                <AdminSessionAlertsTab messages={detail.messages} approvals={detail.approvals} piiRuns={detail.piiRuns} />
              </TabsContent>
              <TabsContent value="approvals" className="data-[state=inactive]:hidden">
                <AdminSessionApprovalsTab approvals={detail.approvals} />
              </TabsContent>
              <TabsContent value="diagnostics" className="space-y-4 data-[state=inactive]:hidden">
                <label className="flex flex-col gap-2 text-sm font-medium sm:flex-row sm:items-center">
                  Diagnostic view
                  <select className="max-w-full rounded-md border border-outline-variant bg-surface px-3 py-2 text-on-surface" value={isDiagnostic ? activeTab : "overview"} onChange={(event) => setActiveTab(event.target.value as SidebarTabId)}>
                    {DIAGNOSTICS.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
                  </select>
                </label>
                {activeTab === "overview" ? <AdminSessionOverviewTab overview={detail.overview} /> : null}
                {activeTab === "tools" ? <AdminSessionToolsTab toolEvents={detail.toolEvents} messageToolResults={detail.messageToolResults} /> : null}
                {activeTab === "artifacts" ? <AdminSessionArtifactsTab artifacts={detail.artifacts} /> : null}
                {activeTab === "pii" ? <AdminSessionPiiTab piiRuns={detail.piiRuns} /> : null}
                {activeTab === "audit" ? <AdminSessionAuditTab auditEvents={detail.auditEvents} /> : null}
                {activeTab === "raw" ? <AdminSessionRawTab messages={detail.messages} /> : null}
              </TabsContent>
            </div>
          </Tabs>
        </CardContent>
      </Card>
      {activeTab === "overview" ? <AdminSessionResourcesCard skills={detail.skills} mcpServers={detail.mcpServers} /> : null}
    </>
  );
}
