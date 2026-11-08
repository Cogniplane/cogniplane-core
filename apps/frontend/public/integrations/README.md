# Integration logos

Scope: logo files for integrations in the admin and settings pages.

Each file is `<logoSlug>.svg`. `logoSlug` is a field of the
`IntegrationDescriptor` that a connector module or an overlay registers (type in
`apps/backend/src/services/integrations/integration-registry.ts`).

## Add a logo

1. Get the SVG from the brand's press kit. If there is none, use
   https://svgl.app; prefer the dark variant with `currentColor` fills.
2. Check the logo's license and the brand's trademark terms before you commit
   it.
3. Save it here as `<logoSlug>.svg`, with the exact slug of the descriptor.
4. Check it at every size where `<IntegrationLogo>` renders it (the admin
   integrations and settings pages).

If the file is missing or does not load, `<IntegrationLogo>` shows a placeholder
(the first letter in a circle, colored by category).
