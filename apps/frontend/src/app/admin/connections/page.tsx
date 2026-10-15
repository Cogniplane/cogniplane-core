"use client";

import { useSearchParams } from "next/navigation";
import { AdminMcpContent } from "../../../components/admin/mcp/admin-mcp-content";
import AdminIntegrationsPage from "../integrations/page";

export default function AdminConnectionsPage() {
  const params = useSearchParams();
  return (
    <div className="flex flex-col gap-5 pt-5">
      <AdminMcpContent targetServerId={params.get("connection")} />
      <AdminIntegrationsPage />
    </div>
  );
}
