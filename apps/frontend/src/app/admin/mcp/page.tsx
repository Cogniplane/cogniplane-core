"use client";

import { useAdminMcpData } from "../../../hooks/use-admin-mcp-data";
import { AdminMcpCard } from "../../../components/admin/mcp/admin-mcp-card";

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
    <section id="mcp" className="flex flex-col gap-5 pt-5">
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
