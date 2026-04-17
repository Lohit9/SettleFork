import Link from 'next/link'
import { GuideLayout, Section, Paragraph, BulletList } from '../GuideLayout'

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 mt-3 mb-3 last:mb-0">
      <p className="text-xs font-semibold text-blue-700 mb-1">💡 Tip</p>
      <p className="text-sm text-blue-700 leading-relaxed">{children}</p>
    </div>
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
    <GuideLayout
      title="Data quality & validation"
      description="Understand how Settle finds issues, suggests fixes, and tracks your migration readiness"
    >
      <Section title="1. Understanding the Migration Readiness Score">
        <Paragraph>
          The <strong>Validate</strong> tab shows your overall Migration Readiness Score (0–100%) —
          a single number that answers &quot;can I load this data into the target system right now?&quot;
        </Paragraph>
        <div className="flex flex-col sm:flex-row gap-2 mt-4 mb-3">
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
        <Paragraph>
          The score accounts for blocking issues, unmapped fields, untested transforms, and data
          quality violations. It updates in real time as you resolve issues.
        </Paragraph>
      </Section>

      <Section title="2. Source vs. In-flight vs. Target validation">
        <Paragraph>
          Settle validates your data at three stages, each shown in its own tab:
        </Paragraph>
        <BulletList items={[
          <><strong>Source Data</strong> — issues in your raw uploaded data before any transformation. Examples: null primary keys, duplicate IDs, invalid email formats, inconsistent date formats.</>,
          <><strong>In-flight Data</strong> — issues detected in transformed data against target field constraints. Examples: values that won&apos;t fit target column lengths, type mismatches after transformation, business rule violations.</>,
          <><strong>Target Data</strong> — post-load reconciliation checks (coming in a future release).</>,
        ]} />
        <Tip>
          In-flight validation is Settle&apos;s biggest differentiator. Most tools only check source
          data. Settle checks whether your data will actually survive the load into the target
          system — catching issues that would otherwise surface as load failures.
        </Tip>
      </Section>

      <Section title="3. Working with AI-suggested fixes">
        <Paragraph>
          For each blocking issue, click to expand and you&apos;ll see an{' '}
          <strong>AI-Suggested Fix</strong> section with 2–3 options. Each option includes:
        </Paragraph>
        <BulletList items={[
          'A description of what the fix does',
          'Risk level (Low / Medium / High)',
          'Tradeoff analysis — what you gain and what you lose',
          'Downstream impact — how this fix affects dependent tables and reports',
          'Estimated rows affected',
          'View SQL — inspect the exact SQL before applying',
        ]} />
        <Paragraph>
          Click <strong>Apply Fix</strong> to execute. Every fix is logged in Fix History and is
          fully reversible.
        </Paragraph>
        <Tip>
          You don&apos;t have to use AI fixes. You can also create manual fixes using natural
          language descriptions or direct SQL via the &quot;+ Create Fix&quot; button.
        </Tip>
      </Section>

      <Section title="4. Custom validation rules">
        <Paragraph>
          Click <strong>+ Add Rule</strong> to define your own validation rules beyond Settle&apos;s
          built-in checks. Two modes:
        </Paragraph>
        <BulletList items={[
          'Natural Language — describe the rule in plain English (e.g., "Revenue should never be negative") and Settle generates the validation logic',
          'Manual — select a rule type (Not Null, Min Value, Max Value, Pattern, etc.) and configure parameters directly',
        ]} />
        <Paragraph>
          Each rule can be set to <strong>Warning</strong> (review recommended) or{' '}
          <strong>Blocking</strong> (must fix before migration).
        </Paragraph>
      </Section>

      <Section title="5. Fix History and reverting changes">
        <Paragraph>
          Every fix Settle applies is tracked in the <strong>Fix History</strong> panel (top-right
          button on the Validate page). Each entry shows:
        </Paragraph>
        <BulletList items={[
          'What was changed and why',
          'How many rows were affected',
          'Timestamp and the SQL that was executed',
          'A Revert option that restores the exact original values',
        ]} />
        <Paragraph>
          Settle snapshots every affected row before applying a fix. Reverting restores the
          complete pre-fix state — not an approximation.
        </Paragraph>
      </Section>

      <Section title="Want to see it in action?">
        <Paragraph>
          Open a project and navigate to the Validate tab.
        </Paragraph>
        <Link
          href="/app/projects"
          className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary/90 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
        >
          Open Validate →
        </Link>
      </Section>
    </GuideLayout>
  )
}
