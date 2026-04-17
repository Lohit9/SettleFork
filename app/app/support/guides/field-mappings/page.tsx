import { GuideLayout, Section, Paragraph, BulletList } from '../GuideLayout'

export default function FieldMappingsGuide() {
  return (
    <GuideLayout
      title="Field mappings"
      description="AI-powered mappings, confidence scores, manual overrides, approval workflow"
    >
      <Section title="AI-generated mappings">
        <Paragraph>
          Settle automatically maps source fields to target fields using AI. Each mapping
          includes a confidence score (0–100%) and AI reasoning explaining why the match was
          suggested. The AI considers field names, data types, sample values, and any uploaded
          documentation.
        </Paragraph>
      </Section>

      <Section title="Reviewing mappings">
        <Paragraph>
          Each mapping is in one of three states:
        </Paragraph>
        <BulletList items={[
          'Needs Review — AI-generated, awaiting your decision.',
          'Approved — confirmed correct, ready for transformation.',
          'Unmapped — no match found or mapping rejected.',
        ]} />
        <Paragraph>
          Use the quick action buttons on hover to approve or reject mappings inline, or
          click a mapping row to open the detail panel for full context, AI reasoning, and
          similar fields considered.
        </Paragraph>
      </Section>

      <Section title="Manual overrides">
        <Paragraph>
          Click any target field name to open the field picker and select a different target
          field. You can also create value assignment mappings for fields that need a static
          or computed value rather than a source field.
        </Paragraph>
      </Section>

      <Section title="Approval workflow">
        <Paragraph>
          Approve mappings individually or use Approve All at the table level for bulk
          approval. Once all mappings in a table are approved, proceed to the Transform step.
        </Paragraph>
      </Section>
    </GuideLayout>
  )
}
