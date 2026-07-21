"use client";

import { useAdminUsersData } from "../../../hooks/use-admin-users-data";
import { AdminUsersSection } from "../../../components/admin/admin-users-section";

export default function AdminUsersPage() {
  const { users, busyKey, error, available, handleSetBetaTester } = useAdminUsersData();

  return (
    <section id="users" className="flex flex-col gap-5 pt-5">
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
