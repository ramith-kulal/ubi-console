/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // oracle-nosqldb must not be bundled by webpack; it is required at runtime
  // from node_modules like it is in ubi-backend.
  experimental: {
    serverComponentsExternalPackages: ['oracle-nosqldb'],
  },
  // Deploy uploads are capped at 200MB in the route handler itself (§5.2.4).
  // Route handlers with request.formData() are not subject to the 1MB Server
  // Action body limit, so nothing extra is needed here.
  poweredByHeader: false,
};

export default nextConfig;
