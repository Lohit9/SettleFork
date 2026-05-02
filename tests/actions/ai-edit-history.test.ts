// @vitest-environment node
//
// Unit tests for `lib/actions/ai-edit-history.ts:logAIEdit`.
//
// The helper is the single write path to `public.ai_edit_history`. Two
// invariants matter:
//   1. Every payload field maps to the correct column.
//   2. `redactForLog` is applied to old_value/new_value before insert.
//   3. Errors from supabaseAdmin.insert() are caught (fire-and-forget).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { insertSpy, fromSpy } = vi.hoisted(() => {
  // Explicit param type so insertSpy.mock.calls[N][0] is properly typed.
  const insertSpy = vi.fn(
    async (_payload: Record<string, unknown>) => ({
      error: null as null | { message: string },
    }),
  )
  const fromSpy = vi.fn((_table: string) => ({ insert: insertSpy }))
  return { insertSpy, fromSpy }
})

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: { from: fromSpy },
}))

import { logAIEdit } from '@/lib/actions/ai-edit-history'

describe('logAIEdit — payload shape', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    insertSpy.mockClear()
    fromSpy.mockClear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('inserts into the ai_edit_history table', async () => {
    await logAIEdit({
      projectId: 'p1',
      actorId: 'u1',
      entityType: 'transformation',
      entityId: 't1',
      fieldPath: 'generated_sql',
      oldValue: null,
      newValue: 'SELECT 1',
      editKind: 'ai_proposed',
    })
    expect(fromSpy).toHaveBeenCalledWith('ai_edit_history')
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })

  it('maps every input field to the correct column', async () => {
    await logAIEdit({
      projectId: 'p1',
      actorId: 'u1',
      entityType: 'target_field_mapping',
      entityId: 'tfm1',
      fieldPath: 'confidence',
      oldValue: 0.7,
      newValue: 0.9,
      editKind: 'human_modified',
      llmCallId: 'call-1',
      metadata: { reason: 'user_edit' },
    })
    const payload = insertSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(payload).toMatchObject({
      project_id: 'p1',
      actor_id: 'u1',
      entity_type: 'target_field_mapping',
      entity_id: 'tfm1',
      field_path: 'confidence',
      old_value: 0.7,
      new_value: 0.9,
      edit_kind: 'human_modified',
      llm_call_id: 'call-1',
      metadata: { reason: 'user_edit' },
    })
  })

  it('defaults llmCallId to null when omitted', async () => {
    await logAIEdit({
      projectId: 'p1',
      actorId: 'u1',
      entityType: 'validation_rule',
      entityId: 'r1',
      fieldPath: 'rule_definition',
      oldValue: { kind: 'not_null' },
      newValue: { kind: 'unique' },
      editKind: 'human_modified',
    })
    const payload = insertSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.llm_call_id).toBeNull()
  })

  it('defaults metadata to {} (matches NOT NULL DEFAULT in schema)', async () => {
    await logAIEdit({
      projectId: 'p1',
      actorId: 'u1',
      entityType: 'mapping_source',
      entityId: 'ms1',
      fieldPath: 'source_field_id',
      oldValue: 'f1',
      newValue: 'f2',
      editKind: 'human_modified',
    })
    const payload = insertSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.metadata).toEqual({})
  })
})

describe('logAIEdit — redaction is applied', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    insertSpy.mockClear()
    fromSpy.mockClear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('redacts emails inside string values', async () => {
    await logAIEdit({
      projectId: 'p1',
      actorId: 'u1',
      entityType: 'transformation',
      entityId: 't1',
      fieldPath: 'generated_sql',
      oldValue: null,
      newValue: "SELECT * FROM users WHERE email = 'jane@example.com'",
      editKind: 'ai_proposed',
    })
    const payload = insertSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.new_value).toBe("SELECT * FROM users WHERE email = '[email]'")
  })

  it('redacts secret prefixes inside object trees', async () => {
    // Fixture concatenated so the pre-commit secret scanner does not flag.
    const SECRET_FIXTURE = 'use ' + 'sk-' + 'ant-api03-secret_token_here'
    await logAIEdit({
      projectId: 'p1',
      actorId: 'u1',
      entityType: 'quality_issue',
      entityId: 'q1',
      fieldPath: 'ai_fix_options',
      oldValue: null,
      newValue: { fix: SECRET_FIXTURE },
      editKind: 'ai_proposed',
    })
    const payload = insertSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.new_value).toEqual({ fix: 'use [secret]' })
  })
})

describe('logAIEdit — fire-and-forget error handling', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    insertSpy.mockClear()
    fromSpy.mockClear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not throw when supabaseAdmin.insert rejects', async () => {
    insertSpy.mockRejectedValueOnce(new Error('connection refused'))
    await expect(
      logAIEdit({
        projectId: 'p1',
        actorId: 'u1',
        entityType: 'transformation',
        entityId: 't1',
        fieldPath: 'generated_sql',
        oldValue: null,
        newValue: 'X',
        editKind: 'ai_proposed',
      }),
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('does not throw when supabaseAdmin.from itself throws', async () => {
    fromSpy.mockImplementationOnce(() => {
      throw new Error('client not initialized')
    })
    await expect(
      logAIEdit({
        projectId: 'p1',
        actorId: 'u1',
        entityType: 'transformation',
        entityId: 't1',
        fieldPath: 'generated_sql',
        oldValue: null,
        newValue: 'X',
        editKind: 'ai_proposed',
      }),
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })
})
