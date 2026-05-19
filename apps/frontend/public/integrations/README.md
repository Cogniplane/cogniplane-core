# Integration logos

Static SVG assets for the integrations admin page (`/admin/integrations`) and
related UI. Filenames match the `logoSlug` field on each `IntegrationDescriptor`
in `apps/backend/src/services/integration-registry.ts` plus a `.svg` extension.

## Adding a new integration's logo

1. Search the brand at https://svgl.app and download the SVG. Prefer the dark
   variant when both light and dark are offered (works on light and dark
   backgrounds with `currentColor` fills).
2. For the production trio (Notion, GitHub, Microsoft) prefer the brand's
   official press kit over svgl when available.
3. Save the file here as `<logoSlug>.svg`, where `<logoSlug>` matches the
   registry entry exactly. Confirm trademark posture per brand — svgl notes
   individual logos may have varying licenses.
4. Verify visually: the `<IntegrationLogo>` component renders the SVG at 24×24.
5. Commit. PR review covers the visual.

## Fallback

If a logo file is missing or fails to load, `<IntegrationLogo>` renders a
procedural placeholder (a circle with the first letter, colored by category).
This is defense-in-depth; in normal operation every registry entry should have
an asset here.
