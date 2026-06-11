"use client";

import type { AdminSessionDetailResourceUsage } from "@cogniplane/shared-types";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PILL_GRAY, PILL_BLUE, HINT, LIST_ITEM, SECTION_LABEL } from "../../../lib/ui-tokens";

function ResourceList(props: {
  label: string;
  items: AdminSessionDetailResourceUsage[];
  emptyText: string;
}) {
  const usedCount = props.items.filter((r) => r.invokedCount > 0).length;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm font-semibold text-on-surface">{props.label}</strong>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={PILL_GRAY} title="Distinct resources invoked in this session.">
            {usedCount} used
          </span>
          <span
            className={PILL_GRAY}
            title="Distinct resources offered to the agent in this session."
          >
            {props.items.length} available
          </span>
        </div>
      </div>
      {props.items.length === 0 ? (
        <p className={`${HINT} mt-2`}>{props.emptyText}</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {props.items.map((item) => (
            <span
              key={item.resourceId}
              className={item.invokedCount > 0 ? PILL_BLUE : PILL_GRAY}
              title={
                item.invokedCount > 0
                  ? `Invoked ${item.invokedCount} time${item.invokedCount === 1 ? "" : "s"}`
                  : "Materialized but never invoked"
              }
            >
              {item.name}
              {item.invokedCount > 0 ? ` · ${item.invokedCount}` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdminSessionResourcesCard(props: {
  skills: AdminSessionDetailResourceUsage[];
  mcpServers: AdminSessionDetailResourceUsage[];
}) {
  return (
    <Card>
      <CardHeader>
        <p className={SECTION_LABEL}>Activity</p>
        <h2 className="text-lg font-semibold text-on-surface">Skills &amp; MCP servers</h2>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          <div className={LIST_ITEM}>
            <ResourceList
              label="Skills"
              items={props.skills}
              emptyText="No skills materialized in this session."
            />
          </div>
          <div className={LIST_ITEM}>
            <ResourceList
              label="MCP servers"
              items={props.mcpServers}
              emptyText="No MCP servers materialized in this session."
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
