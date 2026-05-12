// ─── composeTransformUserMessage ──────────────────────────────────────────────
//
// Pure helper that assembles the user message for `transform_generate`.
// Extracted from `generateTransform` so tests can snapshot the assembled
// message byte-for-byte without mocking the full Supabase / LLM stack.
// Inputs are pre-formatted strings (block bodies, field-specific lines);
// this function performs only concatenation and conditional emission.
//
// Lives in lib/ai/ (not lib/actions/) so the test file can import it
// without transitively pulling in `'server-only'` via the server-action
// module's import chain.
//
// Assembly order (locked by PR 1 STOP 1):
//   field-scoped:  <source_field> → <contributing_source_fields> → <target_field> → <type_compatibility>
//   project-scoped: <lookup_tables> → <project_decisions> → <documentation> → intelligence
//   per-call:      <iteration> → <transformation_intent> → <description>
//   authoritative: <poc_answer_key authoritative="true">  ← LAST, immediately before TASK

export interface TransformUserMessageParts {
  sourceBlock: string
  contributingSourcesBlock: string
  targetTableName: string
  targetFieldName: string
  targetDataType: string
  targetInferredType: string | null
  targetIsNullable: boolean
  /** Pre-rendered "\nAllowed values: …" / "\nValue pattern: …" / "" line. */
  checkConstraintLine: string
  /** Pre-rendered "Distinct values: N" or empty string. */
  targetCardinalityLine: string
  typeCompat: string | null
  lookupTablesBlock: string
  projectDecisionsBlock: string
  documentationBlock: string
  intelligenceContext: string
  iterationBlock: string
  transformationIntentBlock: string
  description: string
  pocBlock: string
}

export function composeTransformUserMessage(p: TransformUserMessageParts): string {
  return `${p.sourceBlock}
${p.contributingSourcesBlock}
<target_field>
Field: ${p.targetTableName}.${p.targetFieldName}
Type: ${p.targetDataType}${p.targetInferredType ? ` (${p.targetInferredType})` : ''}
Nullable: ${p.targetIsNullable}${p.checkConstraintLine}
${p.targetCardinalityLine}
</target_field>

<type_compatibility>
${p.typeCompat ?? 'Not specified'}
</type_compatibility>
${p.lookupTablesBlock ? '\n' + p.lookupTablesBlock + '\n' : ''}${p.projectDecisionsBlock ? '\n' + p.projectDecisionsBlock + '\n' : ''}${p.documentationBlock}
${p.intelligenceContext ? p.intelligenceContext + '\n\n' : ''}${p.iterationBlock}${p.transformationIntentBlock ? p.transformationIntentBlock + '\n\n' : ''}<description>
${p.description}
</description>
${p.pocBlock ? '\n' + p.pocBlock + '\n' : ''}
Generate the SQL transformation expression.`
}
