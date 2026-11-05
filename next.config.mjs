// In GitHub Codespaces the browser reaches the app through a forwarded address (*.app.github.dev),
// so form posts arrive with an origin that differs from the server's host. Trust that address only
// when running inside a codespace, which sets GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN.
const codespacesDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  serverExternalPackages: [],
  experimental: {
    serverActions: {
      bodySizeLimit: '1mb',
      ...(codespacesDomain ? { allowedOrigins: [`*.${codespacesDomain}`, 'localhost:3000'] } : {}),
    },
  },
};
export default nextConfig;
