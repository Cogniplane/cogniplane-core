import type { GithubConnectionStatus } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatMediumDateTime } from "../lib/time-format";
import { PILL_GRAY, PILL_BLUE, HINT, SECTION_LABEL } from "../lib/ui-tokens";

const CHIP =
  "inline-flex items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";

type GithubConnectionSectionProps = {
  status: GithubConnectionStatus | null;
  error: string | null;
  flashMessage: string | null;
  busyKey: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
};

function getConnectionHeadline(status: GithubConnectionStatus | null): string {
  if (status?.userConnection) {
    return `Authorized as ${status.userConnection.githubLogin}`;
  }
  return "GitHub not connected";
}

function getConnectButtonLabel(
  busyKey: string | null,
  userConnection: GithubConnectionStatus["userConnection"]
): string {
  if (busyKey === "connect") return "Redirecting...";
  return userConnection ? "Reconnect GitHub" : "Connect GitHub";
}

export function GithubConnectionSection(input: GithubConnectionSectionProps) {
  const { status, error, flashMessage, busyKey, onConnect, onDisconnect } = input;
  const userConnection = status?.userConnection ?? null;

  return (
    <section id="github" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Live module</p>
        <h3 className="text-lg font-semibold text-on-surface">GitHub</h3>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={SECTION_LABEL}>User identity</p>
                <h2 className="text-lg font-semibold text-on-surface">
                  Connect your GitHub account
                </h2>
                <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
                  Authorize GitHub so the agent can read repositories, write files, and open pull
                  requests on your behalf — using whatever access your GitHub account already has.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={PILL_GRAY}>oauth</span>
                <span className={PILL_GRAY}>per-user</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {flashMessage ? <p className={HINT}>{flashMessage}</p> : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}

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
              <p className={HINT}>GitHub OAuth is not configured on this deployment yet.</p>
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
              <span className={userConnection ? PILL_BLUE : PILL_GRAY}>
                {userConnection ? "user token" : "disconnected"}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            {userConnection ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={CHIP}>login {userConnection.githubLogin}</span>
                  <span className={CHIP}>
                    connected {formatMediumDateTime(userConnection.connectedAt, "Not available")}
                  </span>
                  <span className={CHIP}>
                    last used {formatMediumDateTime(userConnection.lastUsedAt, "Not available")}
                  </span>
                </div>
                <p className={`${HINT} mt-2`}>
                  Token expiry: {formatMediumDateTime(userConnection.accessTokenExpiresAt, "Not available")}. Refresh
                  expiry: {formatMediumDateTime(userConnection.refreshTokenExpiresAt, "Not available")}.
                </p>
              </>
            ) : (
              <p className={HINT}>
                Once you connect, the agent can act on GitHub as you. Disconnect anytime to revoke
                access.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
