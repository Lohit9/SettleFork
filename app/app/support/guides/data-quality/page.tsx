import Link from 'next/link'
import SidebarShell from '@/components/app/SidebarShell'
import { CheckCircle } from '@/components/icons'

function StepBadge({ n }: { n: number }) {
  return (
    <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-medium flex-shrink-0">
      {n}
    </div>
  )
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 mt-3">
      <p className="text-xs font-semibold text-blue-700 mb-1">💡 Tip</p>
      <p className="text-sm text-blue-700 leading-relaxed">{children}</p>
    </div>
  )
}

function BulletList({ items }: { items: (string | React.ReactNode)[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-sm text-gray-600 leading-relaxed">
          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

function ScorePill({ label, color, text }: { label: string; color: string; text: string }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${color}`}>
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs">{text}</span>
    </div>
  )
}

export default function DataQualityGuidePage() {
  return (
    <SidebarShell>
      <div className="flex-1 bg-slate-50 min-h-screen overflow-auto">
        <div className="max-w-3xl mx-auto py-8 px-6">

          {/* Back link */}
          <Link
            href="/app/support"
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors"
          >
            <span>←</span>
            Back to Help Center
          </Link>

          {/* Header */}
          <div className="flex items-start gap-4 mb-8">
            <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center flex-shrink-0 mt-0.5">
              <CheckCircle className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Data quality &amp; validation</h1>
              <p className="text-sm text-gray-500 mt-1">
                Understand how Mine finds issues, suggests fixes, and tracks your migration readiness
              </p>
            </div>
          </div>

          {/* Steps */}
          <div className="space-y-8">

            {/* Step 1 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={1} />
                <h2 className="text-lg font-medium text-gray-900">Understanding the Migration Readiness Score</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                The <strong>Validate</strong> tab shows your overall Migration Readiness Score (0–100%) —
                a single number that answers &quot;can I load this data into the target system right now?&quot;
              </p>
              <div className="flex flex-col sm:flex-row gap-2 mt-4">
                <ScorePill
                  label="90%+"
                  color="bg-green-50 border-green-200 text-green-700"
                  text="Production-ready, safe to proceed"
                />
                <ScorePill
                  label="60–89%"
                  color="bg-amber-50 border-amber-200 text-amber-700"
                  text="At risk, blocking issues remain"
                />
                <ScorePill
                  label="Below 60%"
                  color="bg-red-50 border-red-200 text-red-700"
                  text="Not ready, significant work needed"
                />
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl mt-3">
                The score accounts for blocking issues, unmapped fields, untested transforms, and data
                quality violations. It updates in real time as you resolve issues.
              </p>
            </div>

            {/* Step 2 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={2} />
                <h2 className="text-lg font-medium text-gray-900">Source vs. In-flight vs. Target validation</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                Mine validates your data at three stages, each shown in its own tab:
              </p>
              <BulletList items={[
                <><strong>Source Data</strong> — issues in your raw uploaded data before any transformation. Examples: null primary keys, duplicate IDs, invalid email formats, inconsistent date formats.</>,
                <><strong>In-flight Data</strong> — issues detected in transformed data against target field constraints. Examples: values that won&apos;t fit target column lengths, type mismatches after transformation, business rule violations.</>,
                <><strong>Target Data</strong> — post-load reconciliation checks (coming in a future release).</>,
              ]} />
              <Tip>
                In-flight validation is Mine&apos;s biggest differentiator. Most tools only check source
                data. Mine checks whether your data will actually survive the load into the target
                system — catching issues that would otherwise surface as load failures.
              </Tip>
            </div>

            {/* Step 3 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={3} />
                <h2 className="text-lg font-medium text-gray-900">Working with AI-suggested fixes</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                For each blocking issue, click to expand and you&apos;ll see an{' '}
                <strong>AI-Suggested Fix</strong> section with 2–3 options. Each option includes:
              </p>
              <BulletList items={[
                'A description of what the fix does',
                'Risk level (Low / Medium / High)',
                'Tradeoff analysis — what you gain and what you lose',
                'Downstream impact — how this fix affects dependent tables and reports',
                'Estimated rows affected',
                'View SQL — inspect the exact SQL before applying',
              ]} />
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl mt-3">
                Click <strong>Apply Fix</strong> to execute. Every fix is logged in Fix History and is
                fully reversible.
              </p>
              <Tip>
                You don&apos;t have to use AI fixes. You can also create manual fixes using natural
                language descriptions or direct SQL via the &quot;+ Create Fix&quot; button.
              </Tip>
            </div>

            {/* Step 4 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={4} />
                <h2 className="text-lg font-medium text-gray-900">Custom validation rules</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                Click <strong>+ Add Rule</strong> to define your own validation rules beyond Mine&apos;s
                built-in checks. Two modes:
              </p>
              <BulletList items={[
                'Natural Language — describe the rule in plain English (e.g., "Revenue should never be negative") and Mine generates the validation logic',
                'Manual — select a rule type (Not Null, Min Value, Max Value, Pattern, etc.) and configure parameters directly',
              ]} />
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl mt-3">
                Each rule can be set to <strong>Warning</strong> (review recommended) or{' '}
                <strong>Blocking</strong> (must fix before migration).
              </p>
            </div>

            {/* Step 5 */}
            <div className="pb-4">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={5} />
                <h2 className="text-lg font-medium text-gray-900">Fix History and reverting changes</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                Every fix Mine applies is tracked in the <strong>Fix History</strong> panel (top-right
                button on the Validate page). Each entry shows:
              </p>
              <BulletList items={[
                'What was changed and why',
                'How many rows were affected',
                'Timestamp and the SQL that was executed',
                'A Revert option that restores the exact original values',
              ]} />
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl mt-3">
                Mine snapshots every affected row before applying a fix. Reverting restores the
                complete pre-fix state — not an approximation.
              </p>
            </div>

          </div>

          {/* CTA */}
          <div className="mt-10 bg-white border border-gray-200 rounded-xl p-6 text-center">
            <p className="text-base font-medium text-gray-900 mb-1">Want to see it in action?</p>
            <p className="text-sm text-gray-500 mb-4">Open a project and navigate to the Validate tab.</p>
            <Link
              href="/app/projects"
              className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
            >
              Open Validate →
            </Link>
          </div>

        </div>
      </div>
    </SidebarShell>
  )
}
