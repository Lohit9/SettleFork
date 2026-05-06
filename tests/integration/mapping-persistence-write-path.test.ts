// @vitest-environment node
//
// HOT-FIX 4 — write-path integration test for runMappingGenerationForPair.
//
// The existing heritage test (mappings-for-redesign-heritage.test.ts) is a
// READ-path test on a static project — it never exercises the per-pair
// regenerate flow that customers hit via the "Generate Mappings" button on
// a fresh project. That heritage gap let three production bugs ship in
// rapid succession (May 2026):
//
//   1. PR-CACHE-HOTFIX (#79) — 4-cache_control-block API limit hit on
//      every mapping_generate; 100% failure on real customer projects.
//   2. fix/buildaicontext-field-load-rls (#80, pending) — fields SELECT
//      requested a column never created via migration; silent error
//      swallow surfaced as "0 fields" in the mapping prompt.
//   3. HOT-FIX 4 (this PR) — system prompt advertised data-scanning
//      tools; AI emitted tool_use for them in turns where it never
//      reached emit_table_mappings, draining the loop's iteration /
//      cost cap and persisting zero TFM rows.
//
// All three were invisible to existing tests because the existing tests
// do not exercise:
//   - The actual Anthropic API (cache-block bug)
//   - The user-authed buildAIContext entry (RLS / column drift bug)
//   - The runAgentLoop → callLLM → persistence chain (HOT-FIX 4 bug)
//
// This test plugs the third gap. It mocks callLLM to return a structured
// emit_table_mappings tool_use response (skipping the agent-loop dance,
// just like the legacy single-shot path does in production). The test
// then verifies that the persistence pipeline (translateToolUseResult →
// dq_create_target_field_mapping RPC) writes the expected
// target_field_mappings + mapping_sources rows.
//
// Env-gated: RUN_MAPPING_PERSISTENCE_INTEGRATION=1 + Supabase + EVAL_USER_ID
// + EVAL_ORG_ID. Same gating shape as
// build-ai-context-field-load.test.ts.

import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  EVAL_PROJECT_PREFIX,
  createSyntheticProject,
  teardownSyntheticProject,
} from '@/lib/eval/scratch-context'
import { buildSyntheticMappingContext } from '@/lib/eval/synthetic-context-builder'
import { supabaseAdmin } from '@/lib/supabase/admin'
import type { DatasetSchema } from '@/lib/eval/types'

// ─── Env gating ─────────────────────────────────────────────────────────────

const RUN = process.env.RUN_MAPPING_PERSISTENCE_INTEGRATION === '1'

const HAS_ENV =
  RUN &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) &&
  Boolean(process.env.EVAL_USER_ID) &&
  Boolean(process.env.EVAL_ORG_ID)

const describeFn = HAS_ENV ? describe : describe.skip

// ─── Mocks (mirror tests/integration/mappings-for-redesign-heritage.test.ts) ─

const { callLLMMock } = vi.hoisted(() => ({ callLLMMock: vi.fn() }))

const TEST_USER_ID =
  process.env.EVAL_USER_ID ?? '00000000-0000-0000-0000-000000000000'

// Streaming switch (May 2026 incident): mapping_generate routes
// through callLLMStreaming on every callsite. This mock factory stubs
// BOTH wrappers identically — the runtime distinction (HTTP streaming
// vs single-shot) is invisible to the persistence pipeline because
// both wrappers return the same { kind: 'toolUse' | 'text' } shape.
function buildCallLLMMock(): (opts: {
  systemPrompt: string
  userMessage: string
  maxTokens?: number
  tool?: { name: string }
}) => Promise<unknown> {
  return async (opts) => {
    const result = await callLLMMock(opts.systemPrompt, opts.userMessage, opts.tool?.name)
    // Tests configure the mock to return either a `toolUse`-shaped object
    // (preferred — Phase 2 path) or a raw text string (legacy path). The
    // mock factory wraps both in the CallLLMResult shape.
    if (typeof result === 'string') {
      return {
        kind: 'text',
        text: result,
        callId: '00000000-0000-0000-0000-000000000000',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: null,
        anthropicRequestId: null,
      }
    }
    return {
      kind: 'toolUse',
      toolUse: result,
      callId: '00000000-0000-0000-0000-000000000000',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: null,
      anthropicRequestId: null,
    }
  }
}

vi.mock('@/lib/ai/llm-client', () => ({
  callLLM: buildCallLLMMock(),
  callLLMStreaming: buildCallLLMMock(),
}))

vi.mock('@/lib/supabase/server', async () => {
  const adminMod = await vi.importActual<typeof import('@/lib/supabase/admin')>(
    '@/lib/supabase/admin',
  )
  const { supabaseAdmin: admin } = adminMod

  // Same dq_create_target_field_mapping stub the heritage write-path
  // test uses — bypasses the in-RPC SECURITY DEFINER gate on
  // auth.uid() (admin clients have no auth context).
  const fakeRpc = async (
    fnName: string,
    params: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }> => {
    if (fnName !== 'dq_create_target_field_mapping') {
      return admin.rpc(fnName, params) as unknown as {
        data: unknown
        error: { message: string } | null
      }
    }
    const projectId = params.p_project_id as string
    const targetFieldId = params.p_target_field_id as string
    const combination = (params.p_combination ?? {}) as Record<string, unknown>
    const sources = (params.p_sources ?? []) as Array<Record<string, unknown>>

    const { data: tfm, error: tfmErr } = await admin
      .from('target_field_mappings')
      .insert({
        project_id: projectId,
        target_field_id: targetFieldId,
        confidence: null,
        status: 'needs_review',
        ai_reasoning: combination.ai_reasoning ?? null,
        is_acknowledged: false,
        combination_type: combination.type ?? null,
        combination_sql: combination.sql ?? null,
      })
      .select('id')
      .single()
    if (tfmErr || !tfm) {
      return { data: null, error: tfmErr ?? { message: 'TFM insert failed' } }
    }
    if (sources.length > 0) {
      const rows = sources.map((s) => ({
        target_field_mapping_id: tfm.id,
        source_field_id: s.source_field_id,
        source_table_id: s.source_table_id,
        confidence: s.confidence ?? null,
        ai_reasoning: s.ai_reasoning ?? null,
        similar_fields_considered: s.similar_fields_considered ?? [],
        type_compatibility: s.type_compatibility ?? null,
        join_spec: s.join_spec ?? null,
        ordinal: s.ordinal ?? 0,
      }))
      const { error: msErr } = await admin.from('mapping_sources').insert(rows)
      if (msErr) {
        await admin.from('target_field_mappings').delete().eq('id', tfm.id)
        return { data: null, error: msErr }
      }
    }
    return { data: tfm.id, error: null }
  }

  return {
    createClient: async () => ({
      auth: {
        getUser: async () => ({
          data: { user: { id: TEST_USER_ID } },
          error: null,
        }),
      },
      from: admin.from.bind(admin),
      rpc: fakeRpc,
    }),
  }
})

vi.mock('@/lib/actions/role-resolution', () => ({
  requireProjectPermission: async () => ({ allowed: true }),
  checkProjectPermission: async () => true,
}))

vi.mock('@/lib/auth/mapping-writes', () => ({
  assertMappingWritesEnabled: async () => {},
}))

vi.mock('next/cache', () => ({
  revalidatePath: () => {},
}))

vi.mock('@/lib/ai/rate-limit', () => ({
  checkAIRateLimit: () => ({ allowed: true }),
}))

// ─── Synthetic project fixture ───────────────────────────────────────────────

const SCHEMA: DatasetSchema = {
  source: {
    tables: [
      {
        name: 'customers',
        fields: [
          { name: 'id', data_type: 'uuid', is_primary_key: true, is_nullable: false },
          { name: 'first_name', data_type: 'varchar(50)', is_nullable: true },
          { name: 'last_name', data_type: 'varchar(50)', is_nullable: true },
          { name: 'email', data_type: 'varchar(255)', is_nullable: false },
        ],
      },
    ],
  },
  target: {
    tables: [
      {
        name: 'Account',
        fields: [
          { name: 'Id', data_type: 'varchar(18)', is_primary_key: true, is_nullable: false },
          { name: 'Name', data_type: 'varchar(255)', is_nullable: true },
          { name: 'Email__c', data_type: 'varchar(80)', is_nullable: false },
        ],
      },
    ],
  },
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describeFn(
  '[integration] runMappingGenerationForPair persists target_field_mappings on a fresh project',
  () => {
    const seededProjects: string[] = []

    afterAll(async () => {
      for (const id of seededProjects) {
        await teardownSyntheticProject(id)
      }
    })

    it(
      'mocked emit_table_mappings response → 3 TFM rows + 4 mapping_sources rows persisted',
      async () => {
        const userId = process.env.EVAL_USER_ID!
        const orgId = process.env.EVAL_ORG_ID!
        const projectId = await createSyntheticProject({
          name: `${EVAL_PROJECT_PREFIX}persist-test-${Date.now()}`,
          userId,
          orgId,
        })
        seededProjects.push(projectId)

        const ctx = await buildSyntheticMappingContext({
          projectId,
          schema: SCHEMA,
          sourceTableName: 'customers',
          targetTableName: 'Account',
        })

        // Configure the LLM mock — return a structured emit_table_mappings
        // tool_use with field-level mappings the persistence pipeline can
        // route through dq_create_target_field_mapping. Three field-level
        // mappings: id→Id (one_to_one), first_name+last_name→Name
        // (many_to_one with one contributor), email→Email__c (one_to_one).
        callLLMMock.mockResolvedValueOnce({
          name: 'emit_table_mappings',
          input: {
            table_mappings: [
              {
                source_table: 'customers',
                target_table: 'Account',
                confidence: 95,
                reasoning: 'Mocked test fixture — single-pair persistence verification',
                field_mappings: [
                  {
                    source_field: 'id',
                    target_field: 'Id',
                    confidence: 95,
                    reasoning: 'Both are PKs of the corresponding entity; identical role.',
                    type_compatibility: 'UUID → VARCHAR(18) — compatible string cast',
                    needs_transformation: false,
                  },
                  {
                    source_field: 'first_name',
                    target_field: 'Name',
                    confidence: 88,
                    reasoning: 'first_name + last_name combine into Name (full name).',
                    type_compatibility:
                      'VARCHAR(50) + VARCHAR(50) → VARCHAR(255) — concatenation',
                    needs_transformation: true,
                    mapping_type: 'many_to_one',
                    contributing_source_fields: ['last_name'],
                    combination_hint: 'Concatenate with space separator',
                  },
                  {
                    source_field: 'email',
                    target_field: 'Email__c',
                    confidence: 92,
                    reasoning: 'Direct email field; types compatible after truncation guard.',
                    type_compatibility:
                      'VARCHAR(255) → VARCHAR(80) — truncation, validate against length',
                    needs_transformation: false,
                  },
                ],
              },
            ],
          },
        })

        // Drive the pipeline. Use the per-pair entry (closest to the
        // production "Generate" button path on a fresh project — the
        // BULK path also routes through this helper internally per-pair).
        const { runMappingGenerationForPair } = await import('@/lib/actions/mappings')
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()

        const result = await runMappingGenerationForPair({
          // The createClient() returns the admin-stub from the mock above.
          // Type cast to the Supabase server-client shape the action expects.
          supabase: supabase as unknown as Awaited<ReturnType<typeof createClient>>,
          userId,
          projectId,
          tableMappingId: ctx.tableMappingId,
          sourceTableId: ctx.sourceTableId,
          targetTableId: ctx.targetTableId,
        })

        expect(result.error).toBeUndefined()
        expect(result.inserted).toBeGreaterThan(0)

        // Verify persistence — query DB directly via admin.
        const { data: tfmRows, error: tfmErr } = await supabaseAdmin
          .from('target_field_mappings')
          .select('id, target_field_id, combination_type')
          .eq('project_id', projectId)
        expect(tfmErr).toBeNull()
        // Three field mappings emitted → three TFM rows persisted.
        // (one_to_one + many_to_one + one_to_one = 3 unique target fields).
        expect(tfmRows ?? []).toHaveLength(3)

        // Verify mapping_sources rows — 4 total contributors:
        //   - id → Id              : 1 source
        //   - first_name → Name    : 1 primary
        //   - last_name → Name     : 1 contributor (same TFM as primary)
        //   - email → Email__c     : 1 source
        const tfmIds = (tfmRows ?? []).map((r) => r.id as string)
        const { data: msRows, error: msErr } = await supabaseAdmin
          .from('mapping_sources')
          .select('id, target_field_mapping_id, source_field_id, ordinal')
          .in('target_field_mapping_id', tfmIds)
        expect(msErr).toBeNull()
        expect(msRows ?? []).toHaveLength(4)

        // Verify the many_to_one TFM has TWO sources (primary + contributor).
        const nameFieldId = ctx.targetFieldsByName.get('Name')!
        const nameTfm = (tfmRows ?? []).find((r) => r.target_field_id === nameFieldId)
        expect(nameTfm).toBeDefined()
        const nameSources = (msRows ?? []).filter(
          (r) => r.target_field_mapping_id === nameTfm!.id,
        )
        expect(nameSources).toHaveLength(2)
      },
      60_000,
    )
  },
)
