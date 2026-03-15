import { createClient } from '@supabase/supabase-js'

// Admin client bypasses RLS — use only for server-side admin operations
// NEVER import this in any client component or any file with 'use client'
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
