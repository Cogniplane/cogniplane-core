import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

// Guard: setting NEXT_PUBLIC_DEV_USER_ID during a production build bakes
// dev-headers auth (no JWT, no SSO) into the shipped client bundle. That's
// the right default for Cloudflare Pages or any internet-exposed deploy,
// but the OSS docker-compose path (compose.yaml + docker/frontend.Dockerfile)
// intentionally ships dev-headers — the README and docker-deploy.md both
// document that the stack is for trusted internal use only. Set
// COGNIPLANE_ALLOW_DEV_AUTH_IN_PRODUCTION_BUILD=1 to opt out of the guard.
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PUBLIC_DEV_USER_ID &&
  process.env.COGNIPLANE_ALLOW_DEV_AUTH_IN_PRODUCTION_BUILD !== "1"
) {
  throw new Error(
    "NEXT_PUBLIC_DEV_USER_ID is set during a production build. This bakes dev-headers mode " +
      "(auth bypass) into the shipped bundle. Unset the variable in the build environment, " +
      "set NODE_ENV=development if this is a local dev build, or set " +
      "COGNIPLANE_ALLOW_DEV_AUTH_IN_PRODUCTION_BUILD=1 if you understand the risk " +
      "(self-hosted docker-compose path, trusted users only)."
  );
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: "/admin", destination: "/admin/overview", permanent: false },
      { source: "/settings", destination: "/settings/overview", permanent: false }
    ];
  }
};

export default nextConfig;
