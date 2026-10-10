// Insight is mounted under /insight on the Derby Control hub (PotatOS), which proxies
// /insight/* to this deployment. basePath keeps every route and asset under that prefix on the
// standalone hostname too, so the same build serves both. NEXT_PUBLIC_BASE_PATH is exposed for
// the places that build a URL by hand (lib/basePath.ts).
const BASE_PATH = '/insight'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  basePath: BASE_PATH,
  env: { NEXT_PUBLIC_BASE_PATH: BASE_PATH },
  async redirects() {
    return [
      // The standalone hostname's pre-mount URLs keep working: the root, the wallboard on the
      // control-room displays (fixed URL, may carry ?panel=) and the bookmarked user guide.
      { source: '/', destination: BASE_PATH, basePath: false, permanent: false },
      { source: '/wallboard', destination: `${BASE_PATH}/wallboard`, basePath: false, permanent: false },
      { source: '/user-guide.html', destination: `${BASE_PATH}/user-guide.html`, basePath: false, permanent: false },
    ]
  },
}

module.exports = nextConfig
