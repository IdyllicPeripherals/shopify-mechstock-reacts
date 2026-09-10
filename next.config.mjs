/** @type {import('next').NextConfig} */
const nextConfig = {
  // Never 308-redirect /api/reacts to /api/reacts/ — the Shopify App Proxy
  // does not follow the redirect and the retry 404s.
  trailingSlash: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
