import LandingPageClient from '@/components/LandingPageClient'

const organizationSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Settle',
  url: 'https://usesettle.ai',
  description:
    'AI-native enterprise data migration platform. Automates schema profiling, field mapping, SQL generation, and data quality validation.',
  foundingDate: '2025',
  sameAs: ['https://www.linkedin.com/company/usesettle'],
}

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'How does Settle handle data security?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Settle is hosted on AWS with AES-256-GCM encryption at rest and in transit. All AI processing uses Anthropic Enterprise LLMs — your data is never used for model training. Every field mapping and transformation carries a full audit trail. SOC 2 Type 2 certification is in progress.',
      },
    },
    {
      '@type': 'Question',
      name: 'What systems does Settle connect to?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Settle is built for enterprise migrations from Salesforce, SAP, Oracle, NetSuite, and custom databases. We support SQL Server, PostgreSQL, and API-based source extraction.',
      },
    },
    {
      '@type': 'Question',
      name: 'What if the AI gets a mapping wrong?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Every AI-proposed mapping includes a confidence score and explanation. Your team reviews and approves before anything executes. Ambiguous mappings are flagged for human review — the AI never acts without visibility.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is Settle a consulting service?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'No. Settle is a software platform. We replace the manual spreadsheet-and-SQL work that consultants do today with an autonomous, reusable engine. Consultants can use Settle to accelerate their own delivery.',
      },
    },
    {
      '@type': 'Question',
      name: 'How quickly can we get started?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Connect your source schema and target model, and Settle profiles your data in minutes. First mapping proposals are generated within an hour. Full migration readiness typically takes days, not months.',
      },
    },
  ],
}

export default function Page() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <LandingPageClient />
    </>
  )
}
