/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Where the build output goes.
   *
   * Overridable so a long-running server can be given a directory of its own.
   * `next build` writes BUILD_ID and the client manifests into `.next`, and a
   * `next dev` process serving from the same directory has its module graph
   * pulled out from under it — the page then fails to render with
   * "__webpack_modules__[moduleId] is not a function" and the browser shows a
   * blank white screen.
   *
   * That is exactly what happened during the acceptance run: the test gate
   * (`npm run build`, and `npm run test:e2e`, which builds first) was run while
   * the acceptance server was live. The failure looked like an application bug
   * and was not one.
   *
   * Run an acceptance or demo server with, for example:
   *   NEXT_DIST_DIR=.next-acceptance npx next dev -p 3000
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
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

  experimental: {
    /**
     * How large an upload a Server Action will accept.
     *
     * Next's default is 1 MB, which is smaller than almost any real pitch deck,
     * so on a serverless host the deck upload fails before it reaches any of
     * our own validation. Raised to sit just under the 4.5 MB request-body
     * ceiling that serverless platforms impose.
     *
     * This does NOT make the product's stated 25 MB limit work on Vercel, and
     * it is not meant to: a 25 MB body cannot reach a serverless function at
     * all. Decks between this limit and 25 MB will be refused by the platform,
     * and the fix is to upload straight to Storage from the browser with a
     * signed URL rather than routing the bytes through a function. That is
     * deployment blocker D-1 and is deliberately not attempted here — rewriting
     * the upload path is exactly the change that produced F-7, and it needs its
     * own work and its own tests, not a line in a deployment config.
     */
    serverActions: { bodySizeLimit: '4mb' },
  },
};

export default nextConfig;
