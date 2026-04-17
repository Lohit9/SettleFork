'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

// ─── Profile ────────────────────────────────────────────────────────

export async function updateProfileName(name: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const trimmed = name.trim()
  if (!trimmed) throw new Error('Name cannot be empty')
  if (trimmed.length > 100) throw new Error('Name too long')

  const { error } = await supabase
    .from('profiles')
    .update({ full_name: trimmed, updated_at: new Date().toISOString() })
    .eq('id', user.id)

  if (error) throw new Error('Failed to update name')

  // Also update auth user_metadata so it stays in sync
  await supabase.auth.updateUser({ data: { full_name: trimmed } })

  revalidatePath('/app/settings')
  return { name: trimmed }
}

export async function uploadAvatar(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const file = formData.get('file') as File
  if (!file) throw new Error('No file provided')

  const MAX_SIZE = 2 * 1024 * 1024 // 2MB
  if (file.size > MAX_SIZE) throw new Error('File too large. Maximum 2MB.')

  const allowedTypes = ['image/png', 'image/jpeg', 'image/webp']
  if (!allowedTypes.includes(file.type)) throw new Error('Invalid file type. Use PNG, JPEG, or WebP.')

  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png'
  const filePath = `${user.id}/avatar.${ext}`

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(filePath, file, {
      upsert: true,
      contentType: file.type,
    })

  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`)

  const { data: { publicUrl } } = supabase.storage
    .from('avatars')
    .getPublicUrl(filePath)

  const avatarUrl = `${publicUrl}?t=${Date.now()}`

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
    .eq('id', user.id)

  if (updateError) throw new Error('Failed to save avatar URL')

  revalidatePath('/app/settings')
  return { avatarUrl }
}

// ─── Preferences ────────────────────────────────────────────────────

export type UserPreferences = {
  default_sql_dialect: string
  table_display_density: string
}

export async function getUserPreferences(): Promise<UserPreferences> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase
    .from('user_preferences')
    .select('default_sql_dialect, table_display_density')
    .eq('user_id', user.id)
    .single()

  if (error || !data) {
    return { default_sql_dialect: 'postgresql', table_display_density: 'comfortable' }
  }

  return data
}

export async function updateUserPreference(
  key: 'default_sql_dialect' | 'table_display_density',
  value: string
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const validValues: Record<string, string[]> = {
    default_sql_dialect: ['postgresql', 'tsql', 'mysql', 'oracle', 'sap_hana'],
    table_display_density: ['comfortable', 'compact'],
  }

  if (!validValues[key]?.includes(value)) {
    throw new Error(`Invalid value "${value}" for preference "${key}"`)
  }

  const { error } = await supabase
    .from('user_preferences')
    .upsert(
      { user_id: user.id, [key]: value, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )

  if (error) throw new Error(`Failed to save preference: ${error.message}`)

  revalidatePath('/app/settings')
  return { success: true }
}

// ─── Organizations with member counts ───────────────────────────────

export async function getUserOrganizationsWithCounts() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: memberships, error } = await supabase
    .from('org_memberships')
    .select('role, organizations(id, name, slug)')
    .eq('user_id', user.id)
    .order('joined_at', { ascending: true })

  if (error) throw new Error('Failed to fetch organizations')

  const orgs = await Promise.all(
    (memberships ?? [])
      .filter((m: any) => m.organizations)
      .map(async (m: any) => {
        const { count } = await supabase
          .from('org_memberships')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', m.organizations.id)

        return {
          id: m.organizations.id as string,
          name: m.organizations.name as string,
          slug: m.organizations.slug as string,
          role: m.role as string,
          memberCount: count ?? 0,
        }
      })
  )

  return orgs
}
