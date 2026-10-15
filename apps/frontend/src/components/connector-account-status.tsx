import Link from "next/link";

type ConnectorAccountOption = {
  connectionStatus?: "not_connected" | "connected" | "reconnect_required" | "organization" | "no_auth" | "unavailable";
  accountLabel?: string | null;
};

export function ConnectorAccountStatus({ option }: { option: ConnectorAccountOption }) {
  const status = option.connectionStatus;
  if (!status) return null;
  const label = status === "organization" ? "Uses the organization account."
    : status === "no_auth" ? "No account needed."
    : status === "connected" ? "Your credentials are saved."
    : status === "not_connected" ? "Your account is not connected."
    : status === "reconnect_required" ? "Your account needs a new credential."
    : "This connection is unavailable.";
  return <span className="block text-xs text-on-surface-variant">{label}
    {status === "connected" && option.accountLabel ? ` Account label: ${option.accountLabel} (entered by you).` : null}
    {status === "not_connected" || status === "reconnect_required" ? <> <Link href="/settings/connections" className="font-medium text-on-surface underline underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">{status === "not_connected" ? "Connect" : "Reconnect"}</Link></> : null}
  </span>;
}
