import type { NotionConnectionStatus } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const PILL_BLUE = `${PILL_BASE} bg-accent-soft text-accent`;
const CHIP =
  "inline-flex items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";
const HINT = "text-sm text-on-surface-faint";

type NotionConnectionSectionProps = {
  status: NotionConnectionStatus | null;
  error: string | null;
  flashMessage: string | null;
  busyKey: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
};

function formatTimestamp(value: string | null): string {
  if (!value) return "Not available";
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function getConnectionHeadline(status: NotionConnectionStatus | null): string {
  if (status?.userConnection) {
    const workspace = status.userConnection.notionWorkspaceName;
    const owner = status.userConnection.notionOwnerName ?? status.userConnection.notionOwnerEmail;
    if (workspace && owner) return `Connected as ${owner} in ${workspace}`;
    if (workspace) return `Connected to ${workspace}`;
    return `Connected as ${owner ?? "Notion user"}`;
  }
  if (status?.configured) return "Notion configured for this platform";
  return "Notion not configured";
}

function getConnectButtonLabel(
  busyKey: string | null,
  userConnection: NotionConnectionStatus["userConnection"]
): string {
  if (busyKey === "connect") return "Redirecting...";
  return userConnection ? "Reconnect my account" : "Connect my Notion account";
}

export function NotionConnectionSection(input: NotionConnectionSectionProps) {
  const { status, error, flashMessage, busyKey, onConnect, onDisconnect } = input;
  const userConnection = status?.userConnection ?? null;

  return (
    <section id="notion" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Live module</p>
        <h3 className="text-lg font-semibold text-on-surface">Notion</h3>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={SECTION_LABEL}>User identity</p>
                <h2 className="text-lg font-semibold text-on-surface">
                  Connect your Notion account
                </h2>
                <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
                  Authorize your Notion workspace to let the agent search pages, read content,
                  query databases, and create or update pages on your behalf. The agent only sees
                  workspaces and pages you grant access to during Notion's consent flow.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={PILL_GRAY}>notion</span>
                <span className={PILL_GRAY}>per-user</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {flashMessage ? <p className={HINT}>{flashMessage}</p> : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <div>
              <h3 className="text-sm font-semibold text-on-surface">Authorization</h3>
              <p className={`${HINT} mt-1`}>
                Your Notion credentials are encrypted at rest and used only when the agent needs
                to read or modify Notion content during a session.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                disabled={!status?.configured || busyKey !== null}
                onClick={onConnect}
              >
                {getConnectButtonLabel(busyKey, userConnection)}
              </Button>
              {userConnection ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busyKey !== null}
                  onClick={onDisconnect}
                >
                  {busyKey === "disconnect" ? "Disconnecting..." : "Disconnect"}
                </Button>
              ) : null}
            </div>

            {!status?.configured ? (
              <p className={HINT}>
                Notion OAuth is not configured on this deployment yet. Set
                NOTION_OAUTH_CLIENT_ID, NOTION_OAUTH_CLIENT_SECRET, and NOTION_OAUTH_REDIRECT_URI
                in the backend environment.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={SECTION_LABEL}>Current state</p>
                <h2 className="text-lg font-semibold text-on-surface">
                  {getConnectionHeadline(status)}
                </h2>
              </div>
              <span
                className={
                  userConnection ? PILL_BLUE : status?.configured ? PILL_GRAY : PILL_GRAY
                }
              >
                {userConnection
                  ? "connected"
                  : status?.configured
                    ? "not connected"
                    : "not configured"}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            {userConnection ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {userConnection.notionWorkspaceName ? (
                    <span className={CHIP}>{userConnection.notionWorkspaceName}</span>
                  ) : null}
                  {userConnection.notionOwnerName ? (
                    <span className={CHIP}>{userConnection.notionOwnerName}</span>
                  ) : null}
                  {userConnection.notionOwnerEmail ? (
                    <span className={CHIP}>{userConnection.notionOwnerEmail}</span>
                  ) : null}
                  <span className={CHIP}>
                    connected {formatTimestamp(userConnection.connectedAt)}
                  </span>
                  <span className={CHIP}>
                    last used {formatTimestamp(userConnection.lastUsedAt)}
                  </span>
                </div>
                <p className={`${HINT} mt-2`}>
                  Token expiry: {formatTimestamp(userConnection.accessTokenExpiresAt)}.
                </p>
              </>
            ) : (
              <p className={HINT}>
                Once connected, the agent can search your Notion workspace, fetch pages and
                database rows, and write back when write tools are enabled in agent settings.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
