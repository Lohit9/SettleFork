'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/app/PageHeader'
import { CursorTabs } from '@/components/CursorTabs'
import MembersTab from './tabs/MembersTab'
import InfoTab from './tabs/InfoTab'
import type { ProjectMember, OrgMembership } from '@/lib/types/organizations'

export interface ProjectSettingsInfo {
  projectName: string
  sourceSystem: string | null
  targetSystem: string | null
  createdAt: string
}

interface Props {
  projectId: string
  projectName: string
  info: ProjectSettingsInfo
  initialMembers: ProjectMember[]
  initialAvailableOrgMembers: OrgMembership[]
  currentUserId: string
  isAdmin: boolean
  initialTab: 'members' | 'info'
}

const TABS = [
  { id: 'members', label: 'Members' },
  { id: 'info', label: 'Info' },
]

// Tab strip + tab body. Active tab is held in component state and synced
// to `?tab=...` via `router.replace` so refresh / share-links work. The
// PageHeader on this page intentionally OMITS `projectId` so the gear
// doesn't render — clicking the gear from the settings page would be a
// no-op self-link.
export default function ProjectSettingsContent({
  projectId,
  projectName,
  info,
  initialMembers,
  initialAvailableOrgMembers,
  currentUserId,
  isAdmin,
  initialTab,
}: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'members' | 'info'>(initialTab)

  const handleTabChange = (tabId: string) => {
    if (tabId !== 'members' && tabId !== 'info') return
    setActiveTab(tabId)
    // Mirror the data-overview pattern: shareable URL via query param.
    // `replace` (not `push`) so the back button doesn't accumulate
    // intra-tab navigation steps.
    const url =
      tabId === 'members'
        ? `/app/projects/${projectId}/settings`
        : `/app/projects/${projectId}/settings?tab=${tabId}`
    router.replace(url, { scroll: false })
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-gray-50">
      <PageHeader
        projectName={projectName}
        title="Settings"
      />
      <div className="border-b border-gray-200 bg-white">
        <div className="px-6 pt-3">
          <CursorTabs
            tabs={TABS}
            activeTab={activeTab}
            onTabChange={handleTabChange}
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto px-6 py-6">
          {activeTab === 'members' ? (
            <MembersTab
              projectId={projectId}
              initialMembers={initialMembers}
              initialAvailableOrgMembers={initialAvailableOrgMembers}
              currentUserId={currentUserId}
              isAdmin={isAdmin}
            />
          ) : (
            <InfoTab info={info} />
          )}
        </div>
      </div>
    </div>
  )
}
