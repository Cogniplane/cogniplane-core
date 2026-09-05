import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

// Guard: setting NEXT_PUBLIC_DEV_USER_ID during a production build bakes
// dev-headers auth (no JWT, no SSO) into the shipped client bundle. That's
// unsafe for any internet-exposed deploy. The Dockerfile leaves dev auth off
// unless a caller passes both the dev identity and this explicit opt-in. The
// loopback-only Compose stack does that for its documented local setup.
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
