'use client'

import type {
  GetOrgSsoOverviewResult,
  ListOrgSsoDomainsResult,
  ListOrgSsoLinkedUsersResult,
  ListOrgSsoAuditEventsResult,
} from '@/lib/actions/sso-admin'
import { SsoOverviewCard } from './components/SsoOverviewCard'
import { DomainsList } from './components/DomainsList'
import { LinkedUsersList } from './components/LinkedUsersList'
import { AuditEventsList } from './components/AuditEventsList'
import { SsoEmptyState } from './components/SsoEmptyState'
import { MetadataPreviewCard } from './components/MetadataPreviewCard'
import { MetadataUploadCard } from './components/MetadataUploadCard'

interface Props {
  orgId: string
  orgSlug: string
  overview: GetOrgSsoOverviewResult
  domains: ListOrgSsoDomainsResult
  linkedUsers: ListOrgSsoLinkedUsersResult
  auditEvents: ListOrgSsoAuditEventsResult
  /**
   * True when the calling user is an org owner or admin and may
   * mutate SSO state. False (default) renders the page in
   * read-only mode — no add-domain form, no remove buttons, no
   * editable enforcement dropdown. Defaults to false so the page
   * is read-only-by-default if a parent ever forgets to wire the
   * prop (defense in depth — the actions also enforce this gate
   * server-side).
   */
  canEdit?: boolean
  metadataUploadEnabled: boolean
}

export function SsoSettingsContent({
  orgId,
  orgSlug,
  overview,
  domains,
  linkedUsers,
  auditEvents,
  canEdit = false,
  metadataUploadEnabled,
}: Props) {
  if (overview.ok && !overview.sso_enabled && !metadataUploadEnabled) {
    return <SsoEmptyState />
  }

  const enforcementMode =
    overview.ok ? overview.enforcement_mode : undefined

  return (
    <div className="px-8 py-6 max-w-3xl space-y-4">
      <SsoOverviewCard overview={overview} canEdit={canEdit} orgId={orgId} />

      {overview.ok && overview.sso_enabled ? (
        <MetadataPreviewCard
          idpType={overview.idp_type}
          entityId={overview.entity_id}
          certFingerprintSha256={overview.cert_fingerprint_sha256}
          certSubject={overview.cert_subject}
          certNotBefore={overview.cert_not_before}
          certNotAfter={overview.cert_not_after}
          certSignatureAlgorithm={overview.cert_signature_algorithm}
        />
      ) : null}

      {metadataUploadEnabled && canEdit ? (
        <MetadataUploadCard
          orgId={orgId}
          orgSlug={orgSlug}
          currentProvider={
            overview.ok && overview.sso_enabled
              ? {
                  idpType: overview.idp_type,
                  entityId: overview.entity_id,
                  certFingerprintSha256: overview.cert_fingerprint_sha256,
                  certNotAfter: overview.cert_not_after,
                }
              : null
          }
        />
      ) : null}

      <DomainsList
        domains={domains}
        canEdit={canEdit}
        orgId={orgId}
        enforcementMode={enforcementMode}
      />
      <LinkedUsersList users={linkedUsers} />
      <AuditEventsList events={auditEvents} />
    </div>
  )
}
