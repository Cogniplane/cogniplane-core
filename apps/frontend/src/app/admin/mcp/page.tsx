"use client";

import { useAdminMcpData } from "../../../hooks/use-admin-mcp-data";
import { AdminMcpCard } from "../../../components/admin/mcp/admin-mcp-card";
import { SECTION_LABEL } from "../../../lib/ui-tokens";

export default function AdminMcpPage() {
  const {
    mcpServers,
    busyKey,
    error,
    handleSubmit,
    handlePublish,
    handleUnpublish,
    handleDisable
  } = useAdminMcpData();

  return (
    <section id="mcp" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Connectivity</p>
        <h3 className="text-lg font-semibold text-on-surface">MCP servers</h3>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <AdminMcpCard
        mcpServers={mcpServers}
        busyKey={busyKey}
        onSubmit={handleSubmit}
        onDisable={handleDisable}
        onPublish={handlePublish}
        onUnpublish={handleUnpublish}
      />
    </section>
  );
}
