// The path prefix this app is served under (next.config.js `basePath`). Next.js adds it to
// <Link>, the router and its own assets; anything that builds a URL string by hand
// (window.open, a raw <a href>) must add it here.

export const BASE_PATH: string = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

/** Root-relative path ("/wallboard") → served path ("/insight/wallboard"); "/" → "/insight". Anything else is returned as is. */
export function withBase(path: string, base: string = BASE_PATH): string {
  if (path === '/') return base || '/'
  return path.startsWith('/') && !path.startsWith('//') ? `${base}${path}` : path
}
