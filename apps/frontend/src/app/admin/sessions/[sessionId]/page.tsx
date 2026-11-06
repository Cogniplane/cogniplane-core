"use client";

import { useParams, useSearchParams } from "next/navigation";
import { AdminSessionDetailView } from "../../../../components/admin/sessions/admin-session-detail-view";
import { useAdminSessionDetailData } from "../../../../hooks/use-admin-session-detail";
import { sessionListHref } from "../../../../lib/admin-session-links";

export default function AdminSessionDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const searchParams = useSearchParams();
  const data = useAdminSessionDetailData(params?.sessionId ?? null);
  return <AdminSessionDetailView {...data} backHref={sessionListHref(searchParams.get("from"))} />;
}
