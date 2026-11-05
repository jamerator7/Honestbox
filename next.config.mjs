// In GitHub Codespaces the port forwarder rewrites `origin` to localhost while
// `x-forwarded-host` keeps the *.app.github.dev host, which trips Next's
// Server Actions CSRF check. Allow that origin only inside a Codespace.
const allowedOrigins = process.env.CODESPACES
  ? [`localhost:${process.env.PORT || 3000}`]
  : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  serverExternalPackages: [],
  experimental: { serverActions: { bodySizeLimit: '1mb', allowedOrigins } },
};
export default nextConfig;
