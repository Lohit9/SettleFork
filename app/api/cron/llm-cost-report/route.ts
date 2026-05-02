/**
 * Daily LLM cost report — Phase 0b PR 7.
 *
 * Runs daily via Vercel cron, queries `public.llm_calls` for the past
 * 24 hours, aggregates by feature / project / user, and emails an HTML
 * report to admin recipients via Resend.
 *
 * Auth: Bearer `${CRON_SECRET}` (same pattern as
 * `app/api/cron/auto-archive/route.ts`). The cron route does NOT call
 * `callLLM` — it's read-only against `llm_calls`.
 *
 * If the migration `082_llm_calls.sql` hasn't been applied, the route
 * returns 200 with `{ skipped: true, reason: '<message>' }` instead of
 * sending an email. This makes the first scheduled run after migration
 * apply automatically work without any manual intervention.
 */

export const maxDuration = 60

import { Resend } from 'resend'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { emailLayout } from '@/lib/email/templates'

const ADMIN_RECIPIENTS = ['kaan@usesettle.ai']

interface FeatureRow {
  feature: string
  calls: number
  input_tokens: number | null
  output_tokens: number | null
  cache_read: number | null
  cost_usd: number | null
  avg_latency_ms: number | null
  failures: number
}

interface ProjectRow {
  project: string
  calls: number
  cost_usd: number | null
}

interface UserRow {
  user_email: string
  calls: number
  cost_usd: number | null
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `$${n.toFixed(2)}`
}

function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US')
}

function tableHtml<R extends Record<string, unknown>>(
  rows: R[],
  cols: { key: keyof R; label: string; align?: 'left' | 'right' }[],
): string {
  if (rows.length === 0) {
    return '<p style="margin:0;color:#64748b;font-size:14px;">No data.</p>'
  }
  const headerCells = cols
    .map(
      (c) =>
        `<th align="${c.align ?? 'left'}" style="padding:6px 10px;border-bottom:1px solid #e2e8f0;color:#475569;font-size:13px;font-weight:600;">${c.label}</th>`,
    )
    .join('')
  const bodyRows = rows
    .map((r) => {
      const cells = cols
        .map(
          (c) =>
            `<td align="${c.align ?? 'left'}" style="padding:6px 10px;border-bottom:1px solid #f1f5f9;color:#334155;font-size:13px;">${String(r[c.key] ?? '—')}</td>`,
        )
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')
  return `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:8px 0 16px;"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  // ── Window: past 24 hours ──────────────────────────────────────────────────
  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000)

  // ── Per-feature breakdown ──────────────────────────────────────────────────
  // Supabase JS doesn't have a native GROUP BY for arbitrary aggregation,
  // so pull the rows and aggregate in JS. At expected volume (a few
  // thousand calls/day max in pilots) this is trivially cheap.
  const { data: rows, error: rowsErr } = await supabaseAdmin
    .from('llm_calls')
    .select(
      'feature, project_id, user_id, input_tokens, output_tokens, cache_read_tokens, cost_usd, latency_ms, succeeded',
    )
    .gte('created_at', windowStart.toISOString())
    .lt('created_at', windowEnd.toISOString())

  if (rowsErr) {
    // If the table doesn't exist yet (migration not applied), return a
    // soft-skip so the cron doesn't hard-fail and the first run after
    // apply just works. Surface the error for ops visibility.
    if (
      rowsErr.message.includes('relation') ||
      rowsErr.message.includes('does not exist') ||
      rowsErr.message.includes('schema cache')
    ) {
      console.warn('[cron/llm-cost-report] llm_calls table not present — skipping:', rowsErr.message)
      return Response.json({ skipped: true, reason: 'llm_calls table not present (migration not applied?)' })
    }
    console.error('[cron/llm-cost-report] Query failed:', rowsErr)
    return Response.json({ error: rowsErr.message }, { status: 500 })
  }

  // Phase 1 PR 10.1: exclude eval_* features from the production cost
  // summary so the daily email reflects real customer traffic only.
  // Eval spend is tracked separately via the eval CLI's per-run output.
  // Filtering in JS rather than via PostgREST `not.like` to avoid
  // escape-character subtleties; volume is trivially small.
  const safeRows = (rows ?? []).filter(
    (r) => !((r.feature as string) ?? '').startsWith('eval_'),
  )

  // Aggregations
  const byFeature = new Map<string, FeatureRow>()
  for (const r of safeRows) {
    const f = r.feature as string
    const cur =
      byFeature.get(f) ??
      ({
        feature: f,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read: 0,
        cost_usd: 0,
        avg_latency_ms: 0,
        failures: 0,
      } as FeatureRow)
    cur.calls++
    cur.input_tokens = (cur.input_tokens ?? 0) + Number(r.input_tokens ?? 0)
    cur.output_tokens = (cur.output_tokens ?? 0) + Number(r.output_tokens ?? 0)
    cur.cache_read = (cur.cache_read ?? 0) + Number(r.cache_read_tokens ?? 0)
    cur.cost_usd = (cur.cost_usd ?? 0) + Number(r.cost_usd ?? 0)
    cur.avg_latency_ms = (cur.avg_latency_ms ?? 0) + Number(r.latency_ms ?? 0)
    if (!r.succeeded) cur.failures++
    byFeature.set(f, cur)
  }
  const featureRows = Array.from(byFeature.values())
    .map((r) => ({ ...r, avg_latency_ms: r.calls > 0 ? Math.round((r.avg_latency_ms ?? 0) / r.calls) : 0 }))
    .sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0))

  // Per-project (top 10)
  const projectIds = Array.from(new Set(safeRows.map((r) => r.project_id as string)))
  const { data: projectMeta } = await supabaseAdmin
    .from('projects')
    .select('id, name')
    .in('id', projectIds.length > 0 ? projectIds : ['00000000-0000-0000-0000-000000000000'])
  const projectNameById = new Map((projectMeta ?? []).map((p) => [p.id as string, p.name as string]))
  const byProject = new Map<string, ProjectRow>()
  for (const r of safeRows) {
    const pid = r.project_id as string
    const cur =
      byProject.get(pid) ??
      ({ project: projectNameById.get(pid) ?? `(deleted: ${pid.slice(0, 8)})`, calls: 0, cost_usd: 0 } as ProjectRow)
    cur.calls++
    cur.cost_usd = (cur.cost_usd ?? 0) + Number(r.cost_usd ?? 0)
    byProject.set(pid, cur)
  }
  const projectRows = Array.from(byProject.values())
    .sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0))
    .slice(0, 10)

  // Per-user (top 10) — skip user lookup; show user_id prefix when email
  // unavailable from auth.users via service_role.
  const byUser = new Map<string, UserRow>()
  for (const r of safeRows) {
    const uid = r.user_id as string
    const cur =
      byUser.get(uid) ??
      ({ user_email: uid.slice(0, 8) + '…', calls: 0, cost_usd: 0 } as UserRow)
    cur.calls++
    cur.cost_usd = (cur.cost_usd ?? 0) + Number(r.cost_usd ?? 0)
    byUser.set(uid, cur)
  }
  const userRows = Array.from(byUser.values())
    .sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0))
    .slice(0, 10)

  // Headline metrics
  const totalCalls = safeRows.length
  const totalCostUsd = safeRows.reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0)
  const totalFailures = safeRows.filter((r) => !r.succeeded).length
  const dateLabel = windowStart.toISOString().slice(0, 10)

  // ── Build email body ───────────────────────────────────────────────────────
  const headlineHtml = `
<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:8px 0 24px;">
  <tr>
    <td style="padding:14px 16px;background:#f1f5f9;border-radius:8px;width:33%;">
      <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Total spend</div>
      <div style="font-size:24px;font-weight:600;color:#0f172a;margin-top:4px;">${fmtUsd(totalCostUsd)}</div>
    </td>
    <td style="width:8px;"></td>
    <td style="padding:14px 16px;background:#f1f5f9;border-radius:8px;width:33%;">
      <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Total calls</div>
      <div style="font-size:24px;font-weight:600;color:#0f172a;margin-top:4px;">${fmtInt(totalCalls)}</div>
    </td>
    <td style="width:8px;"></td>
    <td style="padding:14px 16px;background:#f1f5f9;border-radius:8px;width:33%;">
      <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Failures</div>
      <div style="font-size:24px;font-weight:600;color:${totalFailures > 0 ? '#b91c1c' : '#0f172a'};margin-top:4px;">${fmtInt(totalFailures)}</div>
    </td>
  </tr>
</table>
`

  const featureTable = tableHtml(
    featureRows.map((r) => ({
      ...r,
      cost_usd: fmtUsd(r.cost_usd),
      input_tokens: fmtInt(r.input_tokens),
      output_tokens: fmtInt(r.output_tokens),
      cache_read: fmtInt(r.cache_read),
      avg_latency_ms: r.avg_latency_ms !== null ? `${r.avg_latency_ms} ms` : '—',
    })),
    [
      { key: 'feature', label: 'Feature' },
      { key: 'calls', label: 'Calls', align: 'right' },
      { key: 'cost_usd', label: 'Cost', align: 'right' },
      { key: 'input_tokens', label: 'Input', align: 'right' },
      { key: 'output_tokens', label: 'Output', align: 'right' },
      { key: 'avg_latency_ms', label: 'Avg latency', align: 'right' },
      { key: 'failures', label: 'Failures', align: 'right' },
    ],
  )

  const projectTable = tableHtml(
    projectRows.map((r) => ({ ...r, cost_usd: fmtUsd(r.cost_usd) })),
    [
      { key: 'project', label: 'Project' },
      { key: 'calls', label: 'Calls', align: 'right' },
      { key: 'cost_usd', label: 'Cost', align: 'right' },
    ],
  )

  const userTable = tableHtml(
    userRows.map((r) => ({ ...r, cost_usd: fmtUsd(r.cost_usd) })),
    [
      { key: 'user_email', label: 'User (id prefix)' },
      { key: 'calls', label: 'Calls', align: 'right' },
      { key: 'cost_usd', label: 'Cost', align: 'right' },
    ],
  )

  const body = `
<h1 style="font-size:20px;font-weight:600;color:#0f172a;margin:0 0 8px;">Daily LLM cost report — ${dateLabel}</h1>
<p style="margin:0 0 16px;color:#64748b;font-size:14px;">Window: past 24 hours (${windowStart.toISOString()} → ${windowEnd.toISOString()})</p>
${headlineHtml}
<h2 style="font-size:16px;font-weight:600;color:#0f172a;margin:24px 0 8px;">By feature</h2>
${featureTable}
<h2 style="font-size:16px;font-weight:600;color:#0f172a;margin:24px 0 8px;">Top 10 projects by cost</h2>
${projectTable}
<h2 style="font-size:16px;font-weight:600;color:#0f172a;margin:24px 0 8px;">Top 10 users by cost</h2>
${userTable}
`

  const html = emailLayout({ body, signOff: null })

  // ── Send via Resend ────────────────────────────────────────────────────────
  if (!process.env.RESEND_API_KEY) {
    console.warn('[cron/llm-cost-report] RESEND_API_KEY not set — returning report inline without sending')
    return Response.json({
      skipped: true,
      reason: 'RESEND_API_KEY not set',
      summary: { totalCalls, totalCostUsd, totalFailures, dateLabel },
    })
  }

  const resend = new Resend(process.env.RESEND_API_KEY)
  resend.emails
    .send({
      from: 'Settle <info@usesettle.ai>',
      to: ADMIN_RECIPIENTS,
      replyTo: 'info@usesettle.ai',
      subject: `Settle: Daily LLM cost report — ${dateLabel} — ${fmtUsd(totalCostUsd)}`,
      html,
    })
    .catch((err: unknown) =>
      console.error('[cron/llm-cost-report] Resend send failed (non-blocking):', err),
    )

  return Response.json({
    sent: true,
    summary: { totalCalls, totalCostUsd, totalFailures, dateLabel },
    featureCount: featureRows.length,
    projectCount: projectRows.length,
    userCount: userRows.length,
  })
}
