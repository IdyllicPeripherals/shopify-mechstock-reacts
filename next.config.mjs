/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Shopify App Proxy forwards to /api/reacts/ (trailing slash). Next.js would
  // normally 308-redirect that to /api/reacts with a RELATIVE Location, which the
  // storefront resolves against its own origin (mechstock.com.au) and then 404s.
  // Skipping the redirect makes the route handler serve both /api/reacts and
  // /api/reacts/ directly, with no redirect round trip.
  skipTrailingSlashRedirect: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
