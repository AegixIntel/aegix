/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Optimised plates are the same bytes for a given file and width: a minute's cache made every visit fetch them again.
  images: { minimumCacheTTL: 2678400, formats: ["image/avif", "image/webp"] },
  async headers() {
    // The brand plates and the film are not fingerprinted, so a week, then served stale while they are checked.
    return [{ source: "/assets/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=604800, stale-while-revalidate=2592000" }] }];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${process.env.API_INTERNAL_URL ?? "http://localhost:3001"}/:path*` }];
  }
};

export default nextConfig;
