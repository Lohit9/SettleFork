// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'
import type {
  CompletedMapping,
  FieldSignature,
} from '@/lib/validation/migration-template'

const { mockState, resetMockState } = vi.hoisted(() => {
  type TemplateRow = {
    id: string
    org_id: string
    source_system: string
    target_system: string
    migration_count: number
    load_order: Array<{ tableName: string; sequence: number; dependsOn: string[] }>
    created_at: string
    updated_at: string
  }

  type EntryRow = {
    id: string
    template_id: string
    source_sig: FieldSignature
    target_sig: FieldSignature
    transform_sql: string | null
    explanation: string
    confidence: number
    reuse_count: number
    override_count: number
    updated_at: string
  }

  const mockState = {
    templates: [] as TemplateRow[],
    entries: [] as EntryRow[],
    nextTemplateId: 1,
    nextEntryId: 1,
  }

  const resetMockState = () => {
    mockState.templates = []
    mockState.entries = []
    mockState.nextTemplateId = 1
    mockState.nextEntryId = 1
  }

  return { mockState, resetMockState }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
    },
  }),
}))

vi.mock('@/lib/supabase/admin', () => {
  const nowIso = () => new Date().toISOString()

  const makeMigrationTemplatesSelectChain = () => {
    const filters = new Map<string, unknown>()
    const chain = {
      eq: (column: string, value: unknown) => {
        filters.set(column, value)
        return chain
      },
      maybeSingle: async () => {
        const row = mockState.templates.find((t) =>
          Array.from(filters.entries()).every(([k, v]) => (t as Record<string, unknown>)[k] === v),
        )
        return { data: row ?? null, error: null }
      },
    }
    return chain
  }

  const makeTemplateEntriesSelectChain = () => {
    const filters = new Map<string, unknown>()
    const chain = {
      eq: (column: string, value: unknown) => {
        filters.set(column, value)
        return chain
      },
      then: (onResolve: (value: unknown) => unknown) => {
        const data = mockState.entries.filter((entry) =>
          Array.from(filters.entries()).every(([k, v]) => (entry as Record<string, unknown>)[k] === v),
        )
        return Promise.resolve({ data, error: null }).then(onResolve)
      },
    }
    return chain
  }

  const makeTemplateEntriesDeleteChain = () => {
    const filters = new Map<string, unknown>()
    const chain = {
      eq: (column: string, value: unknown) => {
        filters.set(column, value)
        return chain
      },
      then: (onResolve: (value: unknown) => unknown) => {
        mockState.entries = mockState.entries.filter((entry) =>
          !Array.from(filters.entries()).every(([k, v]) => (entry as Record<string, unknown>)[k] === v),
        )
        return Promise.resolve({ error: null }).then(onResolve)
      },
    }
    return chain
  }

  const makeTemplateEntriesUpdateChain = (payload: Record<string, unknown>) => {
    const filters = new Map<string, unknown>()
    const chain = {
      eq: (column: string, value: unknown) => {
        filters.set(column, value)
        return chain
      },
      then: (onResolve: (value: unknown) => unknown) => {
        mockState.entries = mockState.entries.map((entry) => {
          const matches = Array.from(filters.entries()).every(
            ([k, v]) => (entry as Record<string, unknown>)[k] === v,
          )
          return matches ? { ...entry, ...payload } as typeof entry : entry
        })
        return Promise.resolve({ error: null }).then(onResolve)
      },
    }
    return chain
  }

  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table === 'migration_templates') {
          return {
            select: () => makeMigrationTemplatesSelectChain(),
            upsert: (payload: Record<string, unknown>) => ({
              select: () => ({
                single: async () => {
                  const existing = mockState.templates.find(
                    (t) =>
                      t.org_id === payload.org_id &&
                      t.source_system === payload.source_system &&
                      t.target_system === payload.target_system,
                  )

                  if (existing) {
                    existing.migration_count = payload.migration_count as number
                    existing.load_order = payload.load_order as Array<{
                      tableName: string
                      sequence: number
                      dependsOn: string[]
                    }>
                    existing.updated_at = (payload.updated_at as string) ?? nowIso()
                    return { data: { id: existing.id }, error: null }
                  }

                  const row = {
                    id: `tpl-${mockState.nextTemplateId++}`,
                    org_id: payload.org_id as string,
                    source_system: payload.source_system as string,
                    target_system: payload.target_system as string,
                    migration_count: payload.migration_count as number,
                    load_order: payload.load_order as Array<{
                      tableName: string
                      sequence: number
                      dependsOn: string[]
                    }>,
                    created_at: nowIso(),
                    updated_at: (payload.updated_at as string) ?? nowIso(),
                  }
                  mockState.templates.push(row)
                  return { data: { id: row.id }, error: null }
                },
              }),
            }),
          }
        }

        if (table === 'template_entries') {
          return {
            select: () => makeTemplateEntriesSelectChain(),
            insert: async (
              rows: Array<{
                template_id: string
                source_sig: FieldSignature
                target_sig: FieldSignature
                transform_sql: string | null
                explanation: string
                confidence: number
                reuse_count: number
                override_count: number
              }>,
            ) => {
              for (const row of rows) {
                mockState.entries.push({
                  ...row,
                  id: `ent-${mockState.nextEntryId++}`,
                  updated_at: nowIso(),
                })
              }
              return { error: null }
            },
            delete: () => makeTemplateEntriesDeleteChain(),
            update: (payload: Record<string, unknown>) => makeTemplateEntriesUpdateChain(payload),
          }
        }

        throw new Error(`Unexpected table: ${table}`)
      },
    },
  }
})

import {
  findTemplate,
  recordTemplateOutcome,
  saveTemplate,
} from '@/lib/actions/migration-templates'

const orgId = 'org-1'
const sourceSystem = 'NetSuite'
const targetSystem = 'Salesforce'
const loadOrder = [{ tableName: 'accounts', sequence: 1, dependsOn: [] as string[] }]

const completedMappings: CompletedMapping[] = [
  {
    sourceTableName: 'customer',
    sourceFieldName: 'customer_id',
    sourceDataType: 'uuid',
    sourceIsNullable: false,
    sourceIsForeignKey: false,
    targetTableName: 'accounts',
    targetFieldName: 'external_id',
    targetDataType: 'uuid',
    targetIsNullable: false,
    targetIsForeignKey: false,
    transformSql: null,
    explanation: 'Direct id mapping',
    confidence: 95,
  },
]

const targetSig: FieldSignature = {
  tableName: 'accounts',
  fieldName: 'external_id',
  dataType: 'uuid',
  isNullable: false,
  isForeignKey: false,
}

describe('migration-templates actions', () => {
  it('saveTemplate creates a new template with entry count and zero counters', async () => {
    resetMockState()
    vi.clearAllMocks()

    const saved = await saveTemplate(
      orgId,
      sourceSystem,
      targetSystem,
      completedMappings,
      loadOrder,
    )

    expect(saved.success).toBe(true)
    expect(saved.data?.isNew).toBe(true)
    expect(saved.data?.entryCount).toBe(1)

    expect(mockState.entries).toHaveLength(1)
    expect(mockState.entries[0]?.reuse_count).toBe(0)
    expect(mockState.entries[0]?.override_count).toBe(0)
  })

  it('findTemplate returns the template after save', async () => {
    resetMockState()
    vi.clearAllMocks()

    await saveTemplate(orgId, sourceSystem, targetSystem, completedMappings, loadOrder)
    const found = await findTemplate(orgId, sourceSystem, targetSystem)

    expect(found.success).toBe(true)
    expect(found.data).not.toBeNull()
    expect(found.data?.entries).toHaveLength(1)
    expect(found.data?.entries[0]?.target).toEqual(targetSig)
  })

  it('recordTemplateOutcome accepted=true increments reuse_count', async () => {
    resetMockState()
    vi.clearAllMocks()

    const saved = await saveTemplate(orgId, sourceSystem, targetSystem, completedMappings, loadOrder)
    const templateId = saved.data?.templateId as string

    const result = await recordTemplateOutcome(templateId, targetSig, true)

    expect(result).toEqual({ success: true })
    expect(mockState.entries[0]?.reuse_count).toBe(1)
    expect(mockState.entries[0]?.override_count).toBe(0)
  })

  it('recordTemplateOutcome accepted=false increments override_count', async () => {
    resetMockState()
    vi.clearAllMocks()

    const saved = await saveTemplate(orgId, sourceSystem, targetSystem, completedMappings, loadOrder)
    const templateId = saved.data?.templateId as string

    mockState.entries[0]!.reuse_count = 2

    const result = await recordTemplateOutcome(templateId, targetSig, false)

    expect(result).toEqual({ success: true })
    expect(mockState.entries[0]?.reuse_count).toBe(2)
    expect(mockState.entries[0]?.override_count).toBe(1)
  })

  it('self-corrects by replacing source_sig and transform_sql when overrides exceed reuse', async () => {
    resetMockState()
    vi.clearAllMocks()

    const saved = await saveTemplate(orgId, sourceSystem, targetSystem, completedMappings, loadOrder)
    const templateId = saved.data?.templateId as string

    const overriddenSource: FieldSignature = {
      tableName: 'client',
      fieldName: 'crm_id',
      dataType: 'uuid',
      isNullable: false,
      isForeignKey: false,
    }

    const result = await recordTemplateOutcome(templateId, targetSig, false, {
      source: overriddenSource,
      transformSql: 'coalesce(client.crm_id, customer.customer_id)',
      explanation: 'Prefer CRM id',
      confidence: 88,
    })

    expect(result).toEqual({ success: true })
    expect(mockState.entries[0]?.source_sig).toEqual(overriddenSource)
    expect(mockState.entries[0]?.transform_sql).toBe('coalesce(client.crm_id, customer.customer_id)')
    expect(mockState.entries[0]?.reuse_count).toBe(0)
    expect(mockState.entries[0]?.override_count).toBe(0)
  })
})
