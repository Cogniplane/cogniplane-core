"use client";

import { useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { PersonalCapabilitiesForm } from "@/components/personal-capabilities";
import { PersonalSkills } from "@/components/personal-skills";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function PersonalCapabilitiesPage() {
  const { user } = useAuth();
  const params = useSearchParams();
  if (!user) return null;
  const submissionId = params.get("view") === "submissions" ? params.get("submission") : null;
  // Admins send `?tab=defaults` to a member who must change their chat defaults.
  const initialTab = params.get("tab") === "defaults" && !submissionId ? "defaults" : "skills";
  return <ScopedCapabilitiesPage key={`${user.tenantId}:${user.userId}`}
    scope={{ tenantId: user.tenantId, userId: user.userId }} requestedSubmissionId={submissionId} initialTab={initialTab} />;
}

function ScopedCapabilitiesPage({ scope, requestedSubmissionId, initialTab }: { scope: { tenantId: string; userId: string }; requestedSubmissionId: string | null; initialTab: "skills" | "defaults" }) {
  const [tab, setTab] = useState<"skills" | "defaults">(initialTab);
  const [skillsDirty, setSkillsDirty] = useState(false);
  const [defaultsDirty, setDefaultsDirty] = useState(false);
  const [defaultsKey, setDefaultsKey] = useState(0);
  const onDirtyChange = useCallback((dirty: boolean) => setSkillsDirty(dirty), []);
  const onDefaultsDirtyChange = useCallback((dirty: boolean) => setDefaultsDirty(dirty), []);
  const changeTab = (value: string) => {
    const next = value === "defaults" ? "defaults" : "skills";
    if (next === tab) return;
    if (tab === "skills" && skillsDirty && !window.confirm("Discard your unsaved skill changes?")) return;
    if (tab === "defaults" && defaultsDirty && !window.confirm("Discard your unsaved chat defaults?")) return;
    if (next === "defaults") setDefaultsKey((value) => value + 1);
    setTab(next);
  };
  return <Tabs value={tab} onValueChange={changeTab} activationMode="manual" className="space-y-1">
    <TabsList variant="line" aria-label="Skills and connections settings" className="border-b border-outline-variant">
      <TabsTrigger value="skills">Private skills</TabsTrigger>
      <TabsTrigger value="defaults">Chat defaults</TabsTrigger>
    </TabsList>
    {tab === "skills" ? <TabsContent value="skills">
      <PersonalSkills expectedScope={scope} requestedSubmissionId={requestedSubmissionId} onDirtyChange={onDirtyChange} onChanged={() => setDefaultsKey((value) => value + 1)} />
    </TabsContent> : <TabsContent value="defaults">
      <PersonalCapabilitiesForm key={defaultsKey} expectedScope={scope} onDirtyChange={onDefaultsDirtyChange} />
    </TabsContent>}
  </Tabs>;
}
