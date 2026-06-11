"use client";

import { useAdminUsersData } from "../../../hooks/use-admin-users-data";
import { AdminUsersSection } from "../../../components/admin/admin-users-section";
import { SECTION_LABEL } from "../../../lib/ui-tokens";

export default function AdminUsersPage() {
  const { users, busyKey, error, available, handleSetBetaTester } = useAdminUsersData();

  return (
    <section id="users" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Access</p>
        <h3 className="text-lg font-semibold text-on-surface">Users</h3>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {available ? (
        <AdminUsersSection
          users={users}
          busyKey={busyKey}
          onSetBetaTester={handleSetBetaTester}
        />
      ) : null}
    </section>
  );
}
