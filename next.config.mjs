/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['sharp'],
  experimental: { serverActions: { bodySizeLimit: '120mb' } },
};
export default nextConfig;
