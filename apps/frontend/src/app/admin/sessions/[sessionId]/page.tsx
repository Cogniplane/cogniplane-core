"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useMemo } from "react";

import { AdminChatReplay } from "../../../../components/admin/sessions/admin-chat-replay";
import { AdminSessionDetailSidebar } from "../../../../components/admin/sessions/admin-session-detail-sidebar";
import { AdminSessionResourcesCard } from "../../../../components/admin/sessions/admin-session-resources-card";
import { useAdminSessionDetailData } from "../../../../hooks/use-admin-session-detail";
import type { AdminSessionDetailOverview } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatTimestamp } from "../../../../lib/time-format";
import { PILL_GRAY, PILL_GREEN, HINT, SECTION_LABEL } from "../../../../lib/ui-tokens";

function buildBackHref(fromParam: string | null): string {
  if (!fromParam) return "/admin/sessions";
  try {
    const decoded = decodeURIComponent(fromParam);
    return decoded ? `/admin/sessions?${decoded}` : "/admin/sessions";
  } catch {
    return "/admin/sessions";
  }
}

function statusBadgeClass(status: AdminSessionDetailOverview["status"]): string {
  switch (status) {
    case "active":
      return PILL_GREEN;
    case "errored":
    default:
      return PILL_GRAY;
  }
}

function HeaderStrip(props: { overview: AdminSessionDetailOverview; backHref: string }) {
  const { overview } = props;
  const handleCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(overview.sessionId);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={SECTION_LABEL}>
              <Link href={props.backHref} className="hover:underline">
                ← Back to sessions
              </Link>
            </p>
            <h2 className="text-lg font-semibold text-on-surface">
              {overview.sessionName || "Session"}
            </h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              {overview.userEmail ?? overview.userId} · started{" "}
              {formatTimestamp(overview.createdAt)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={statusBadgeClass(overview.status)}>{overview.status}</span>
            <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
              Copy session ID
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-on-surface-faint">{overview.sessionId}</p>
      </CardContent>
    </Card>
  );
}

export default function AdminSessionDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const searchParams = useSearchParams();
  const sessionId = params?.sessionId ?? null;
  const { detail, error, available, isNotFound, isLoading } =
    useAdminSessionDetailData(sessionId);
  const backHref = useMemo(() => buildBackHref(searchParams.get("from")), [searchParams]);

  return (
    <section id="session-detail" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Review</p>
        <h3 className="text-lg font-semibold text-on-surface">Session detail</h3>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="pt-6">
            <p className={HINT}>Loading session…</p>
          </CardContent>
        </Card>
      ) : null}

      {!isLoading && isNotFound ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-danger">Session not found or not in your tenant.</p>
            <p className="mt-2 text-sm text-on-surface-variant">
              <Link href={backHref} className="text-accent hover:underline">
                Back to sessions
              </Link>
            </p>
          </CardContent>
        </Card>
      ) : null}

      {!isLoading && error ? <p className="text-sm text-danger">{error}</p> : null}

      {!isLoading && available && detail ? (
        <>
          <HeaderStrip overview={detail.overview} backHref={backHref} />

          <AdminSessionResourcesCard
            skills={detail.skills}
            mcpServers={detail.mcpServers}
          />

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className={SECTION_LABEL}>Conversation</p>
                  <h2 className="text-lg font-semibold text-on-surface">Chat replay</h2>
                </div>
                <span className={PILL_GRAY}>
                  {detail.messages.length} message{detail.messages.length === 1 ? "" : "s"}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <AdminChatReplay messages={detail.messages} piiRuns={detail.piiRuns} />
            </CardContent>
          </Card>

          <AdminSessionDetailSidebar detail={detail} />
        </>
      ) : null}
    </section>
  );
}
