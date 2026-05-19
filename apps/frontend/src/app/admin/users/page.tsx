"use client";

import { useAdminUsersData } from "../../../hooks/use-admin-users-data";
import { AdminUsersSection } from "../../../components/admin-users-section";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";

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
