export type OrgRole = 'owner' | 'admin' | 'editor' | 'reviewer' | 'viewer'

export const ROLE_HIERARCHY: Record<OrgRole, number> = {
  owner: 5,
  admin: 4,
  editor: 3,
  reviewer: 2,
  viewer: 1,
}

export interface Organization {
  id: string
  name: string
  slug: string
  created_at: string
  created_by: string
}

export interface OrgMembership {
  id: string
  org_id: string
  user_id: string
  role: OrgRole
  joined_at: string
  user_name?: string
  user_email?: string
}

export interface OrgInvite {
  id: string
  org_id: string
  email: string
  role: OrgRole
  token: string
  invited_by: string
  created_at: string
  accepted_at: string | null
  expires_at: string
  org_name?: string
  inviter_name?: string
}

export interface ProjectMember {
  id: string
  project_id: string
  user_id: string
  role: OrgRole | null
  assigned_at: string
  user_name?: string
  user_email?: string
}
