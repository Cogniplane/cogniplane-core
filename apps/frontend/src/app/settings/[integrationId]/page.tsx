"use client";

import { notFound, useParams } from "next/navigation";

import { withSectionComponents } from "../settings-section-components";
import { listSettingsLiveSections } from "../settings-sections";

// Overlays register their sections when this module loads. The import makes
// the page independent of the order in which the layouts load.
import "../../../overlays";

// Detail page for a registered settings section, for example a connector.
// Static sibling routes (connections, memories, ...) take precedence over
// this route.
//
// The page looks at all registered sections, not only the enabled ones. A
// member must be able to open a service page after an administrator turns
// the service off, for example to remove an account. Each detail component
// shows its own disabled state.
export default function SettingsSectionDetailPage() {
  const params = useParams<{ integrationId: string }>();
  const found = listSettingsLiveSections().find((entry) => entry.id === params?.integrationId);
  const section = found ? withSectionComponents(found) : undefined;
  if (!section?.detail) notFound();
  const Detail = section.detail;
  return <Detail />;
}
