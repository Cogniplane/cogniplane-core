"use client";

import Link from "next/link";
import { listSettingsLiveSections } from "../settings-sections";
import { useEnabledSettingsSections } from "../../../hooks/use-enabled-settings-sections";
import { useAuth } from "../../../lib/auth-context";
import { MemberMcpAccounts } from "../../../components/member-mcp-accounts";
import { withSectionComponents } from "../settings-section-components";

export default function ConnectedAccountsPage() {
  const { user } = useAuth();
  const { liveSections, isLoading, error, retry } = useEnabledSettingsSections();
  const otherAccounts = listSettingsLiveSections().filter((section) => section.kind === "integration" && !liveSections.some((live) => live.id === section.id)).map(withSectionComponents).filter((section) => section.detail);
  const accounts = liveSections.filter((section) => section.kind === "integration").map(withSectionComponents);

  return (
    <section id="connections" className="pt-5">
      <p className="mb-5 max-w-2xl text-sm text-on-surface-variant">
        Connect your own account for each service you use. Your organization controls which
        services are available; enabling a service does not connect your account.
      </p>
      {error ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-danger">{error}</p>
          <button type="button" onClick={retry} className="text-sm font-medium text-on-surface underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-primary">Retry</button>
        </div>
      ) : null}
      {isLoading ? (
        <p role="status" className="text-sm text-on-surface-variant">Loading available services…</p>
      ) : accounts.length > 0 ? (
        <ul className="overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
          {accounts.map((account) => {
            const Row = account.accountRow;
            return Row ? <Row key={account.id} /> : null;
          })}
        </ul>
      ) : !error ? (
        <p className="rounded-xl border border-outline-variant bg-surface-container-lowest p-6 text-sm text-on-surface-variant">
          No built-in account services are enabled for your organization.
        </p>
      ) : null}
      {otherAccounts.length > 0 ? <details className="mt-5 rounded-lg border border-outline-variant bg-surface-container-lowest p-4 text-sm">
        <summary className="min-h-9 cursor-pointer rounded-md font-medium text-on-surface focus-visible:outline-2 focus-visible:outline-primary">Other account details</summary>
        <p className="mt-2 max-w-prose text-on-surface-variant">These services may be turned off for your organization. Open their details to check for an existing account or disconnect it.</p>
        <ul className="mt-3 flex flex-wrap gap-2">{otherAccounts.map(account => <li key={account.id}><Link href={`/settings/${account.id}`} className="inline-flex min-h-9 items-center rounded-md border border-input px-3 text-sm text-on-surface hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-primary">{account.label} account details</Link></li>)}</ul>
      </details> : null}
      {user ? <MemberMcpAccounts key={`${user.tenantId}:${user.userId}`}
        expectedScope={{ tenantId: user.tenantId, userId: user.userId }} /> : null}
    </section>
  );
}
