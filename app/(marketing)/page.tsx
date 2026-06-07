import LandingPageClient from '@/components/LandingPageClient'

const organizationSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Settle',
  url: 'https://settledata.ai',
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
      name: 'Does the AI write directly to my production database?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'No. The model only proposes mappings and transforms. Deterministic engines validate every row, and nothing loads until your team approves the export. Settle holds no standing write access to your target.',
      },
    },
    {
      '@type': 'Question',
      name: 'How does Settle handle data security?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Data is encrypted in transit and at rest. AI processing runs on Anthropic Enterprise LLMs, and your data is never used to train any model. Every profile, mapping, validation, and approval is versioned and logged. SOC 2 is kicking off soon and a pen test is in progress; full security documentation is available under NDA.',
      },
    },
    {
      '@type': 'Question',
      name: 'What sources and targets does Settle support?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: "Settle works across common enterprise systems — ERPs, CRMs, HRIS, Legal-tech, and databases — plus flat-file exports like CSV and DDL when a direct connection isn't possible. The migrations catalog lists 100+ supported paths, and because mappings are packaged and re-runnable, new paths are added quickly. If your pair isn't listed, ask — many engagements start from exactly that conversation.",
      },
    },
    {
      '@type': 'Question',
      name: 'What happens to rows that fail validation?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: "They're blocked, not silently loaded. Every failed row is flagged with the rule it broke and the AI's proposed fix, and your team resolves or accepts each flag in review. Nothing reaches the target until flags are cleared and the load is approved — which is why errors at cutover are zero by design.",
      },
    },
    {
      '@type': 'Question',
      name: 'Can we run Settle in our own environment?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: "Settle runs as a managed deployment hosted on AWS today, with data encrypted in transit and at rest and not retained beyond the migration. Settle can be deployed in your own private cloud on demand; VPC deployment is on our enterprise roadmap — talk to us if it's a requirement.",
      },
    },
    {
      '@type': 'Question',
      name: 'How is this different from a custom ETL script or a systems integrator?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: "Three differences: speed, accuracy, and reuse. Scripts and integrator engagements are one-off work — weeks of mapping locked in code you can't easily audit or re-run, verified by spot checks. Settle is faster because the AI proposes the mappings up front, more accurate because deterministic engines validate every row against your rules, and reusable because the whole migration ships as a versioned, explainable, re-runnable package. The rigor of an SI engagement at software speed — and the audit trail stays yours.",
      },
    },
    {
      '@type': 'Question',
      name: 'How long does a migration actually take?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: "It depends on volume, sources, and schema complexity, which is why every migration is scoped individually. The pattern is consistent though: profiling to a production-ready package in days to weeks rather than months, because the AI proposes the mappings up front and your team's time goes to review and approval instead of authoring. Ask for an estimate and we'll scope yours.",
      },
    },
  ],
}

const webPageSchema = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Settle — AI-Native Data Migration',
  url: 'https://settledata.ai',
  speakable: {
    '@type': 'SpeakableSpecification',
    cssSelector: ['.hero-description', '.faq-section'],
  },
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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(webPageSchema) }}
      />
      <LandingPageClient />
    </>
  )
}
