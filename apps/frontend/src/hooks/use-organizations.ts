"use client";

import { useEffect, useState } from "react";

import { z } from "@cogniplane/shared-types";

import { requestJson } from "../lib/api-client";

export type OrganizationSummary = {
  id: string;
  name: string;
};

const OrganizationsResponseSchema = z.object({
  organizations: z.array(z.object({ id: z.string(), name: z.string() }))
});

export function useOrganizations(enabled: boolean): OrganizationSummary[] {
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await requestJson("/auth/organizations", OrganizationsResponseSchema);
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
