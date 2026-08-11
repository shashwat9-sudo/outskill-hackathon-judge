/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Source-only workspace packages; Next transpiles them (see ADR-002/003).
  transpilePackages: ['@ohj/shared', '@ohj/ai'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        // Judging data must never be cached by a proxy or a shared browser.
        source: '/admin/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
