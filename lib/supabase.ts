'use client'

import { createBrowserClient } from '@supabase/ssr'
import { SupabaseClient } from '@supabase/supabase-js'

// Since stage 3 of Overseer sign-in (PotatOS doc 10 §7) the tables answer only a signed-in Overseer
// person with this system switched on. In the browser the client reads Overseer's session cookie
// (same site, sb-<project>-auth-token), so the person's sign-in carries in.
let _client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient | null {
  if (typeof window === 'undefined') return null
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  if (!_client) _client = createBrowserClient(url, key, { cookieOptions: { path: '/', sameSite: 'lax', secure: location.protocol === 'https:' } })
  return _client
}

export function isSupabaseConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
}
