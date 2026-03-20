import Link from 'next/link'
import SidebarShell from '@/components/app/SidebarShell'
import { RefreshCw } from '@/components/icons'

function StepBadge({ n }: { n: number }) {
  return (
    <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-sm font-medium flex-shrink-0">
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

function ExampleList({ items }: { items: string[] }) {
  return (
    <div className="mt-3 bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-1">
      {items.map((item, i) => (
        <p key={i} className="text-sm text-gray-600 font-mono">
          &quot;{item}&quot;
        </p>
      ))}
    </div>
  )
}

export default function TransformsGuidePage() {
  return (
    <SidebarShell>
      <div className="flex-1 bg-gray-50 min-h-screen overflow-auto">
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
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center flex-shrink-0 mt-0.5">
              <RefreshCw className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Writing transforms</h1>
              <p className="text-sm text-gray-500 mt-1">
                Use natural language to generate SQL transformations, then test and apply them field by field
              </p>
            </div>
          </div>

          {/* Steps */}
          <div className="space-y-8">

            {/* Step 1 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={1} />
                <h2 className="text-lg font-medium text-gray-900">When you need a transform</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                Not every field needs a transformation. Mine flags fields that do need one — typically
                because:
              </p>
              <BulletList items={[
                'The source and target have different data formats (e.g., "USD 1,500.00" → numeric 1500.00)',
                'Values need to be standardized (e.g., "CA", "Calif.", "California" → "CA")',
                'Fields need to be combined or split (e.g., first_name + last_name → full_name)',
                'Business logic must be applied (e.g., currency conversion, status code mapping)',
              ]} />
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl mt-3">
                The Transform tab shows a field tree on the left with badges indicating which fields
                need transforms.
              </p>
            </div>

            {/* Step 2 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={2} />
                <h2 className="text-lg font-medium text-gray-900">Describe your transform in natural language</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                Select a field from the tree and describe what you want in the text box. Examples:
              </p>
              <ExampleList items={[
                'Concatenate $ at the end',
                'Convert all values to uppercase',
                "Map 'Active' to 1, 'Inactive' to 0, everything else to NULL",
                'Add 1 to each price',
                'Extract the year from the date string',
              ]} />
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl mt-3">
                Click <strong>Generate Transform</strong> and Mine produces a SQL expression (CASE
                statement, function call, etc.).
              </p>
              <Tip>
                Be specific. &quot;Clean up the dates&quot; is vague. &quot;Convert dates from MM/DD/YYYY format
                to YYYY-MM-DD&quot; gives Mine exactly what it needs.
              </Tip>
            </div>

            {/* Step 3 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={3} />
                <h2 className="text-lg font-medium text-gray-900">Review the generated SQL</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                The generated SQL appears below your description with an{' '}
                <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded font-medium">AI-Generated</span>{' '}
                badge. You can:
              </p>
              <BulletList items={[
                'Edit the SQL directly if you want to fine-tune it',
                'Click Clear to start over',
                'The SQL is an expression (not a full statement) — it gets embedded into a controlled query',
              ]} />
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl mt-3">
                If you modify the SQL, the badge changes to{' '}
                <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded font-medium">Modified</span>.
              </p>
            </div>

            {/* Step 4 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={4} />
                <h2 className="text-lg font-medium text-gray-900">Test before applying</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                The live preview auto-populates as you type — no button click needed. The test table
                shows:
              </p>
              <BulletList items={[
                'Before column — original source values',
                'After column — values after applying the transform',
              ]} />
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl mt-3">
                Toggle to <strong>All Distinct Values</strong> mode to see every unique source value
                and what it transforms to — critical for catching edge cases the 20-row sample might
                miss.
              </p>
              <Tip>
                Check for edge cases. Does the transform handle NULL values? Empty strings? Values you
                didn&apos;t expect? The test runs on real data, so unexpected values will surface here.
              </Tip>
            </div>

            {/* Step 5 */}
            <div className="pb-4">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={5} />
                <h2 className="text-lg font-medium text-gray-900">Save and apply</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                Once you&apos;re satisfied with the preview results:
              </p>
              <BulletList items={[
                'Apply Transform — applies the transform to all rows and updates the staged data. The sidebar icon updates to a green ✅ Applied indicator.',
                'Save — stores the transform without applying it to staged data. The sidebar shows a 💾 Saved indicator.',
                'You can also use Auto-Generate All Transforms to have Mine generate transforms for every flagged field at once.',
              ]} />
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl mt-3">
                When all transforms are ready, click <strong>Continue to Validation</strong> to move
                to the next phase.
              </p>
              <Tip>
                If you edit a saved transform, its status changes to &quot;Stale&quot; (⚠️) — reminding you
                to re-apply before proceeding. The live preview updates immediately so you can see the
                effect of your changes without re-clicking.
              </Tip>
            </div>

          </div>

          {/* CTA */}
          <div className="mt-10 bg-white border border-gray-200 rounded-xl p-6 text-center">
            <p className="text-base font-medium text-gray-900 mb-1">Ready to write your first transform?</p>
            <p className="text-sm text-gray-500 mb-4">Open a project and navigate to the Transform tab.</p>
            <Link
              href="/app/projects"
              className="inline-flex items-center gap-1.5 bg-[#4F46E5] hover:bg-[#4338CA] text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
            >
              Open Transform →
            </Link>
          </div>

        </div>
      </div>
    </SidebarShell>
  )
}
