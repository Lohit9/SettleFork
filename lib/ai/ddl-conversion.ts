/**
 * DDL conversion.
 *
 * Takes arbitrary schema documentation text (data dictionaries extracted
 * from PDFs, Excel exports, CSVs, Word docs, OCR'd ERD diagrams, etc.) and
 * asks Claude to transform it into standard PostgreSQL CREATE TABLE
 * statements. The output is then re-verified with the deterministic DDL
 * parser so we only ever hand syntactically valid DDL to the downstream
 * merge pipeline — anything Claude hallucinated and can't parse is dropped.
 *
 * Server-only. Never import from client components (ANTHROPIC_API_KEY).
 */

import { callLLM } from '@/lib/ai/llm-client'
import { parseDDL } from '@/lib/parsers/ddl-parser'

// Lower bound below which the document is almost certainly not a schema
// description worth converting. Keeps us from burning a Claude call on empty
// or trivial extractions (e.g. an OCR result that produced only a title).
const MIN_INPUT_CHARS = 50

// Upper bound on input we send to Claude. 15k chars is roughly 4-5k tokens,
// leaving plenty of headroom for the 4096-token completion.
const MAX_INPUT_CHARS = 15_000

// Lower bound on Claude's DDL output before we even bother parsing. A 20-char
// "response" is either empty, an error message, or a single comment line —
// none of which contain CREATE TABLE.
const MIN_OUTPUT_CHARS = 20

const DDL_CONVERT_SYSTEM = `You are a database schema expert. Convert the following schema documentation into PostgreSQL CREATE TABLE DDL statements. Include all structural metadata you can identify:
- PRIMARY KEY declarations
- FOREIGN KEY declarations with REFERENCES (format: FOREIGN KEY (field) REFERENCES table(field))
- NOT NULL constraints
- CHECK constraints (especially IN lists for allowed values)
- Accurate data types with precision (VARCHAR(n), DECIMAL(p,s), DATE, TIMESTAMP, INT, BIGINT, BOOLEAN, TEXT)

If the document describes multiple tables, generate a CREATE TABLE for each.
If a relationship is described, express as FOREIGN KEY constraint.
If a field is described as 'required' or 'mandatory', add NOT NULL.
If allowed values are listed, add CHECK constraint with IN list.

Output ONLY the DDL statements. No explanations, no markdown, no code fences. Just clean SQL.`

/**
 * Convert schema documentation text into PostgreSQL DDL via Claude.
 *
 * Returns the cleaned, parser-verified DDL text on success, or null when the
 * input was too short, Claude returned nothing useful, or the output failed
 * parser verification. Never throws — callers should treat `null` as
 * "deterministic merge isn't possible, let AI enrichment handle it".
 */
export async function convertDocToDDL(
  projectId: string,
  userId: string,
  documentText: string,
): Promise<string | null> {
  if (!documentText || documentText.trim().length < MIN_INPUT_CHARS) {
    return null
  }

  const truncated = documentText.slice(0, MAX_INPUT_CHARS)

  let raw: string
  try {
    const result = await callLLM({
      feature: 'ddl_conversion',
      systemPrompt: DDL_CONVERT_SYSTEM,
      userMessage: truncated,
      maxTokens: 4096,
      projectId,
      userId,
      promptVersion: 'ddl-conversion-v1',
      abuseUserId: userId,
    })
    // PR 12.2 B-2: stay-text callsite (DDL text — downstream parseDDL is
    // the structural validator, per Phase A §2.9). No `tool` is passed.
    raw = result.kind === 'text' ? result.text : ''
  } catch (err) {
    console.error('[DDL Convert] Claude call failed:', err)
    return null
  }

  // Claude tends to ignore "no markdown" and emit fences anyway. Strip them
  // defensively so the downstream parser doesn't choke on ``` at the start.
  const cleaned = raw
    .replace(/^```(?:sql|ddl|postgresql|postgres)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  if (!cleaned || cleaned.length < MIN_OUTPUT_CHARS) {
    console.log('[DDL Convert] Claude returned empty or too-short DDL output')
    return null
  }

  // Parser gate: if parseDDL finds zero CREATE TABLE blocks, Claude emitted
  // prose, half-baked SQL, or some other unparseable artifact. Drop it rather
  // than forward garbage to mergeConstraintsFromDDL.
  let parsedCount = 0
  try {
    parsedCount = parseDDL(cleaned).length
  } catch (err) {
    console.warn('[DDL Convert] parseDDL threw on AI output:', err)
    return null
  }

  if (parsedCount === 0) {
    console.log('[DDL Convert] parseDDL returned empty — AI-generated DDL was not valid')
    return null
  }

  console.log(
    `[DDL Convert] Converted document to ${parsedCount} CREATE TABLE statement(s)`
  )
  return cleaned
}
