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

function ExampleList({ items }: { items: string[] }) {
  return (
    <div className="mt-3 mb-3 bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-1">
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
    <GuideLayout
      title="Transformations"
      description="Use natural language to generate SQL transformations, then test and apply them field by field"
    >
      <Section title="1. When you need a transform">
        <Paragraph>
          Not every field needs a transformation. Settle flags fields that do need one — typically
          because:
        </Paragraph>
        <BulletList items={[
          'The source and target have different data formats (e.g., "USD 1,500.00" → numeric 1500.00)',
          'Values need to be standardized (e.g., "CA", "Calif.", "California" → "CA")',
          'Fields need to be combined or split (e.g., first_name + last_name → full_name)',
          'Business logic must be applied (e.g., currency conversion, status code mapping)',
        ]} />
        <Paragraph>
          The Transform tab shows a field tree on the left with badges indicating which fields
          need transforms.
        </Paragraph>
      </Section>

      <Section title="2. Describe your transform in natural language">
        <Paragraph>
          Select a field from the tree and describe what you want in the text box. Examples:
        </Paragraph>
        <ExampleList items={[
          'Concatenate $ at the end',
          'Convert all values to uppercase',
          "Map 'Active' to 1, 'Inactive' to 0, everything else to NULL",
          'Add 1 to each price',
          'Extract the year from the date string',
        ]} />
        <Paragraph>
          Click <strong>Generate Transform</strong> and Settle produces a SQL expression (CASE
          statement, function call, etc.).
        </Paragraph>
        <Tip>
          Be specific. &quot;Clean up the dates&quot; is vague. &quot;Convert dates from MM/DD/YYYY format
          to YYYY-MM-DD&quot; gives Settle exactly what it needs.
        </Tip>
      </Section>

      <Section title="3. Review the generated SQL">
        <Paragraph>
          The generated SQL appears below your description with an{' '}
          <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">AI-Generated</span>{' '}
          badge. You can:
        </Paragraph>
        <BulletList items={[
          'Edit the SQL directly if you want to fine-tune it',
          'Click Clear to start over',
          'The SQL is an expression (not a full statement) — it gets embedded into a controlled query',
        ]} />
        <Paragraph>
          If you modify the SQL, the badge changes to{' '}
          <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded font-medium">Modified</span>.
        </Paragraph>
      </Section>

      <Section title="4. Test before applying">
        <Paragraph>
          The live preview auto-populates as you type — no button click needed. The test table
          shows:
        </Paragraph>
        <BulletList items={[
          'Before column — original source values',
          'After column — values after applying the transform',
        ]} />
        <Paragraph>
          Toggle to <strong>All Distinct Values</strong> mode to see every unique source value
          and what it transforms to — critical for catching edge cases the 20-row sample might
          miss.
        </Paragraph>
        <Tip>
          Check for edge cases. Does the transform handle NULL values? Empty strings? Values you
          didn&apos;t expect? The test runs on real data, so unexpected values will surface here.
        </Tip>
      </Section>

      <Section title="5. Save and apply">
        <Paragraph>
          Once you&apos;re satisfied with the preview results:
        </Paragraph>
        <BulletList items={[
          'Apply Transform — applies the transform to all rows and updates the staged data. The sidebar icon updates to a green ✅ Applied indicator.',
          'Save — stores the transform without applying it to staged data. The sidebar shows a 💾 Saved indicator.',
          'You can also use Auto-Generate All Transforms to have Settle generate transforms for every flagged field at once.',
        ]} />
        <Paragraph>
          When all transforms are ready, click <strong>Continue to Validation</strong> to move
          to the next phase.
        </Paragraph>
        <Tip>
          If you edit a saved transform, its status changes to &quot;Stale&quot; (⚠️) — reminding you
          to re-apply before proceeding. The live preview updates immediately so you can see the
          effect of your changes without re-clicking.
        </Tip>
      </Section>

      <Section title="Ready to write your first transform?">
        <Paragraph>
          Open a project and navigate to the Transform tab.
        </Paragraph>
        <Link
          href="/app/projects"
          className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary/90 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
        >
          Open Transform →
        </Link>
      </Section>
    </GuideLayout>
  )
}
