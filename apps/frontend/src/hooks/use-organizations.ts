"use client";

import { useEffect, useState } from "react";

import { request } from "../lib/api-client";

export type OrganizationSummary = {
  id: string;
  name: string;
};

type OrganizationsResponse = {
  organizations: OrganizationSummary[];
};

export function useOrganizations(enabled: boolean): OrganizationSummary[] {
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await request<OrganizationsResponse>("/auth/organizations");
        if (!cancelled) setOrganizations(data.organizations);
      } catch {
        if (!cancelled) setOrganizations([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return organizations;
}
