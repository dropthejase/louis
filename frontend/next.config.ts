import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  output: "export",
  images: { unoptimized: true },
  // Static export does not support rewrites — remove sitemap rewrites.
  // Sitemap generation should move to a build-time script or be served
  // from the API Lambda if needed post-migration.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
