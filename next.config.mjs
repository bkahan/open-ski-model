import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  // Disable SW in `next dev` so HMR isn't fighting a cached shell.
  disable: process.env.NODE_ENV === "development",
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin file-tracing to this project so Next 16 doesn't latch onto an
  // unrelated package-lock.json in a parent directory.
  outputFileTracingRoot: import.meta.dirname,
  experimental: {
    optimizePackageImports: ["maplibre-gl"],
  },
};

export default withSerwist(nextConfig);
