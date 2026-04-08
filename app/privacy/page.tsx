import Link from 'next/link'
import Image from 'next/image'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy — Settle',
  description: 'Settle privacy policy: how we collect, use, and protect your data.',
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Nav bar */}
      <header className="border-b border-gray-100 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Image
              src="/images/logos/settle-logo-full.svg"
              alt="Settle"
              width={126}
              height={28}
              className="h-7 w-auto"
            />
          </Link>
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 transition-colors">
            ← Back to Home
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-3xl mx-auto px-6 py-14">
        {/* Title block */}
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold text-gray-900 mb-1">Privacy Policy</h1>
          <p className="text-sm text-gray-500">
            Effective Date: March 26, 2026 &nbsp;|&nbsp; Last Updated: March 26, 2026
          </p>
        </div>

        <div className="prose prose-gray max-w-none text-[15px] leading-relaxed">

          <p>
            Settle (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) operates the usesettle.ai platform
            (&ldquo;the Platform&rdquo;). This Privacy Policy describes how we collect, use, protect, and handle
            information when you use our Platform. We are committed to protecting the privacy and security of your data.
          </p>

          <Section number="1" title="Information We Collect">
            <SubSection title="Account Information">
              <p>
                When you create an account, we collect your email address and authentication credentials. We use
                Supabase Authentication, which supports email/password login with email verification.
              </p>
            </SubSection>

            <SubSection title="Migration Project Data">
              <p>
                When you use Settle, you may upload data for migration analysis, including source and target schemas,
                data files (CSV, JSON, DDL), and related documentation. This is the core data Settle processes to
                generate mappings, transformations, and quality analysis.
              </p>
              <p className="mt-3">
                <strong>Important:</strong> Your migration project data is yours. We do not use your data to train AI
                models, share it with other customers, or access it for any purpose other than providing the
                Platform&rsquo;s services to you.
              </p>
            </SubSection>

            <SubSection title="Usage Information">
              <p>
                We collect standard usage data such as pages visited, features used, and session duration to improve
                the Platform&rsquo;s performance and user experience.
              </p>
            </SubSection>
          </Section>

          <Section number="2" title="How We Use Your Information">
            <p>We use the information we collect to:</p>
            <ul>
              <li>Provide, operate, and maintain the Platform</li>
              <li>
                Process your migration data through our analysis, mapping, transformation, and validation engines
              </li>
              <li>
                Generate AI-powered insights including schema mappings, transformation SQL, data quality assessments,
                and migration readiness reports
              </li>
              <li>Authenticate your identity and secure your account</li>
              <li>Respond to your requests and provide customer support</li>
              <li>Improve and develop the Platform</li>
            </ul>
            <p>We do not sell, rent, or trade your personal information or migration data to third parties.</p>
          </Section>

          <Section number="3" title="AI Processing and Data Handling">
            <p>
              Settle uses the Anthropic Claude API to power AI features such as schema mapping suggestions,
              transformation generation, and quality issue detection. When you use these features, relevant portions of
              your project data are sent to Anthropic&rsquo;s API for processing.
            </p>
            <p>
              Anthropic&rsquo;s API is used under their standard terms of service. We send only the data necessary to
              complete each specific AI task — we do not send your full dataset to the AI provider.
            </p>
            <p>
              <strong>We do not use your data to train or fine-tune any AI models.</strong>
            </p>
          </Section>

          <Section number="4" title="Data Storage and Security">
            <p>
              Your data is stored using Supabase, a managed PostgreSQL platform with row-level security enabled. File
              uploads (CSVs, DDLs, documents) are stored in Supabase Storage with access controls tied to your
              account.
            </p>
            <p>
              We implement appropriate technical and organizational measures to protect your data against unauthorized
              access, alteration, disclosure, or destruction. All data is transmitted over HTTPS.
            </p>
          </Section>

          <Section number="5" title="Data Retention">
            <p>
              We retain your project data for as long as your account is active or as needed to provide you with the
              Platform&rsquo;s services. You may delete your projects and associated data at any time from within the
              Platform. Upon account deletion, your data will be removed from our systems within 30 days.
            </p>
          </Section>

          <Section number="6" title="Sharing of Information">
            <p>We share your information only in the following limited circumstances:</p>
            <ul>
              <li>
                <strong>Service providers:</strong> We use Supabase (database and storage), Anthropic (AI processing),
                and Vercel (hosting). Each is bound by appropriate data processing terms.
              </li>
              <li>
                <strong>Legal requirements:</strong> We may disclose information if required by law, regulation, or
                valid legal process.
              </li>
              <li>
                <strong>Business transfers:</strong> In the event of a merger, acquisition, or sale of assets, your
                information may be transferred as part of that transaction.
              </li>
            </ul>
            <p>We do not sell your personal information.</p>
          </Section>

          <Section number="7" title="Your Rights">
            <p>You have the right to:</p>
            <ul>
              <li>Access the personal information we hold about you</li>
              <li>Request correction of inaccurate data</li>
              <li>Request deletion of your data</li>
              <li>Export your project data</li>
              <li>Withdraw consent at any time (where processing is based on consent)</li>
            </ul>
            <p>
              To exercise any of these rights, contact us at{' '}
              <a href="mailto:privacy@usesettle.ai" className="text-indigo-600 hover:underline">
                privacy@usesettle.ai
              </a>
              .
            </p>
          </Section>

          <Section number="8" title="Cookies">
            <p>
              Settle uses essential cookies required for authentication and session management. We do not use third-party
              advertising or tracking cookies.
            </p>
          </Section>

          <Section number="9" title="Children's Privacy">
            <p>
              The Platform is not directed to individuals under the age of 16. We do not knowingly collect personal
              information from children.
            </p>
          </Section>

          <Section number="10" title="Changes to This Policy">
            <p>
              We may update this Privacy Policy from time to time. We will notify you of material changes by posting
              the updated policy on this page and updating the &ldquo;Last Updated&rdquo; date. Continued use of the
              Platform after changes constitutes your acceptance of the updated policy.
            </p>
          </Section>

          <Section number="11" title="Contact Us">
            <p>If you have questions or concerns about this Privacy Policy, please contact us:</p>
            <ul>
              <li>
                <strong>Email:</strong>{' '}
                <a href="mailto:privacy@usesettle.ai" className="text-indigo-600 hover:underline">
                  privacy@usesettle.ai
                </a>
              </li>
              <li>
                <strong>Website:</strong>{' '}
                <a href="https://usesettle.ai" className="text-indigo-600 hover:underline">
                  usesettle.ai
                </a>
              </li>
            </ul>
          </Section>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-8 px-6 mt-8">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <span className="text-sm text-gray-400">© 2026 Settle. All rights reserved.</span>
          <Link href="/" className="text-sm text-gray-400 hover:text-gray-600 transition-colors">
            Back to Home
          </Link>
        </div>
      </footer>
    </div>
  )
}

// ── Section helpers ────────────────────────────────────────────────────────────

function Section({
  number,
  title,
  children,
}: {
  number: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold text-gray-900 mb-3 pb-2 border-b border-gray-200">
        {number}. {title}
      </h2>
      <div className="space-y-3 text-gray-700">{children}</div>
    </section>
  )
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <h3 className="text-base font-semibold text-indigo-700 mb-1">{title}</h3>
      <div className="text-gray-700">{children}</div>
    </div>
  )
}
