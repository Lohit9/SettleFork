import type { Metadata } from 'next'
import Header from '@/components/Header'
import Footer from '@/components/Footer'
import ApplyButton from '@/components/careers/ApplyButton'

export const metadata: Metadata = {
  title: 'Co-Founder & CTO — Settle',
  description:
    'Settle is hiring its Co-Founder & CTO to own agent architecture, engineering, and enterprise security. In the Antler residency, paying enterprise customer live.',
  openGraph: {
    title: 'Co-Founder & CTO — Settle',
    description:
      'Build the AI-native enterprise data migration platform alongside the founder. In the Antler residency, paying enterprise customer live.',
    url: 'https://usesettle.ai/careers/co-founder-cto',
    siteName: 'Settle',
    type: 'website',
    images: [
      {
        url: 'https://usesettle.ai/images/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Co-Founder & CTO at Settle',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Co-Founder & CTO — Settle',
    description:
      'Build the AI-native enterprise data migration platform alongside the founder.',
    images: ['https://usesettle.ai/images/og-image.png'],
  },
}

export default function CoFounderCTORolePage() {
  return (
    <>
      <Header />
      <main>
        {/* Hero */}
        <section className="px-6 py-12 md:py-16">
          <div className="max-w-4xl mx-auto text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-settle-blue-600 mb-5">
              Careers · Now hiring
            </p>
            <h1 className="text-4xl md:text-6xl font-bold text-[#0F172A] tracking-tight leading-[1.1]">
              Co-Founder &amp; CTO at Settle
            </h1>
            <p className="text-lg md:text-xl text-[#475569] mt-6 max-w-2xl mx-auto leading-relaxed">
              Build the AI-native enterprise data migration platform alongside the founder.
            </p>
            <div className="mt-8">
              <a href="#apply"
                 className="inline-block bg-settle-blue-500 hover:bg-settle-blue-600 text-white font-semibold px-8 py-4 rounded-xl text-base transition-colors">
                Apply now
              </a>
            </div>
          </div>
        </section>

        {/* Founder letter */}
        <section className="px-6 py-12 bg-[#F8FAFC] border-y border-[#E2E8F0]">
          <div className="max-w-3xl mx-auto">
            <p className="text-xs font-semibold uppercase tracking-widest text-[#64748B] mb-5">
              From the founder
            </p>
            <h2 className="text-3xl md:text-4xl font-bold text-[#0F172A] tracking-tight mb-8">
              A note from Kaan
            </h2>
            <div className="space-y-5 text-[17px] text-[#334155] leading-[1.75]">
              <p>
                I spent years at Deloitte watching billion-dollar companies hire armies of consultants to do work that should take software hours. Enterprise data migration is one of the last great manual workflows — schema mismatches, transformation logic, validation done by hand on every customer onboarding, M&amp;A integration, and legacy system replacement.
              </p>
              <p>
                We're building the AI-native version: AI proposes, deterministic engines validate, humans approve. Paying enterprise customer in production today, active pipeline of mid-market software companies, in the Antler residency.
              </p>
              <p>
                I'm hiring the person who'll own the technical side alongside me — co-founder economics, CTO scope, full ownership of agent architecture and engineering culture from day one. Cash is below market, equity is generous, and we're transparent about what that trade means.
              </p>
              <p>
                If you've shipped LLM systems in production, care about correctness more than novelty, and want to build the system that makes enterprise data migration finally work — I want to talk.
              </p>
              <p className="font-medium text-[#0F172A] pt-2">— Kaan, Founder &amp; CEO</p>
            </div>
          </div>
        </section>

        {/* The role */}
        <section className="px-6 py-12">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-bold text-[#0F172A] tracking-tight mb-6">
              The role
            </h2>
            <p className="text-[17px] text-[#334155] leading-[1.75] mb-6">
              You'll own the full technical side of the company. Specifically:
            </p>
            <ul className="space-y-2 text-[17px] text-[#334155] leading-[1.75]">
              <li>
                <strong className="text-[#0F172A]">Phase 3 agent architecture</strong> — design and ship the agent loop, decomposition strategy, eval harness, and validation pipeline. The next 3–6 months.
              </li>
              <li>
                <strong className="text-[#0F172A]">Engineering strategy</strong> — own technical direction, infrastructure decisions, and architectural choices as we scale.
              </li>
              <li>
                <strong className="text-[#0F172A]">Enterprise security and compliance</strong> — be the technical face in customer security reviews. Drive SOC 2 prep post-seed.
              </li>
              <li>
                <strong className="text-[#0F172A]">Hiring and team building</strong> — recruit and lead the engineering team as we grow from two to ten.
              </li>
              <li>
                <strong className="text-[#0F172A]">Customer and product</strong> — partner with the founder on product strategy, talk directly to customers, and shape the roadmap.
              </li>
            </ul>
            <p className="text-[17px] text-[#334155] leading-[1.75] mt-6">
              This role is not for someone who wants to write code in isolation. It's for someone who wants to build a company.
            </p>
          </div>
        </section>

        {/* Who you are */}
        <section className="px-6 py-12 bg-[#F8FAFC] border-y border-[#E2E8F0]">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-bold text-[#0F172A] tracking-tight mb-8">
              Who you are
            </h2>

            <h3 className="text-xl font-semibold text-[#0F172A] mb-4">Must-have</h3>
            <ul className="list-disc pl-6 space-y-2 text-[17px] text-[#334155] leading-[1.75] mb-6">
              <li>
                5–9 years of engineering experience, with 3+ years shipping production systems used by real customers
              </li>
              <li>
                Production LLM or agent system experience — has built and deployed applications using LLM APIs in production. Knows prompt engineering, structured outputs, retries, evaluation. Non-negotiable.
              </li>
              <li>
                Strong backend and data fundamentals — Postgres at depth, schema design, SQL, async/queue patterns, idempotency
              </li>
              <li>TypeScript proficient. Next.js or Node ideal.</li>
              <li>Has shipped to paying customers, not just side projects</li>
            </ul>

            <h3 className="text-xl font-semibold text-[#0F172A] mb-4">Strong preference</h3>
            <ul className="list-disc pl-6 space-y-2 text-[17px] text-[#334155] leading-[1.75] mb-6">
              <li>
                Background in data engineering, integration, migration, or ETL — alumni from Snowflake, Databricks, Airbyte, dbt Labs, Fivetran, Mulesoft, Workato, Informatica, or Talend will understand the problem viscerally
              </li>
              <li>
                Enterprise SaaS instincts — already knows what SSO, RBAC, audit logs, and SOC 2 mean and why they matter
              </li>
              <li>
                Has built eval frameworks (Braintrust, Langfuse, or homegrown) — Phase 3 success depends on this
              </li>
              <li>
                Production cloud experience — has shipped and operated cloud-native applications in AWS, GCP, Azure, or modern PaaS (Vercel, Supabase, Render, Fly.io)
              </li>
            </ul>

            <h3 className="text-xl font-semibold text-[#0F172A] mb-4">Cultural fit</h3>
            <ul className="list-disc pl-6 space-y-2 text-[17px] text-[#334155] leading-[1.75]">
              <li>Investigation-first — you read code before changing it</li>
              <li>Comfortable presenting in enterprise security reviews</li>
              <li>High agency, can decide and ship without direction</li>
              <li>Direct communicator — corporate-comms styles won't fit</li>
            </ul>
          </div>
        </section>

        {/* What we offer */}
        <section className="px-6 py-12">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-bold text-[#0F172A] tracking-tight mb-8">
              What we offer
            </h2>
            <ul className="space-y-2 text-[17px] text-[#334155] leading-[1.75]">
              <li>
                <strong className="text-[#0F172A]">Title:</strong> Co-Founder &amp; CTO
              </li>
              <li>
                <strong className="text-[#0F172A]">Equity:</strong> 15–25% common stock. 4-year vest, 1-year cliff. Range based on background and timing of join.
              </li>
              <li>
                <strong className="text-[#0F172A]">Cash:</strong> $110K–$150K base. Salary ramps to $200K–$300K on seed close — written into the offer.
              </li>
              <li>
                <strong className="text-[#0F172A]">Optional structure:</strong> part of equity can be milestone-based (Series A close, eval targets) for upside alignment
              </li>
              <li>
                <strong className="text-[#0F172A]">Location:</strong> NYC. In-person.
              </li>
              <li>
                <strong className="text-[#0F172A]">Stage:</strong> Pre-seed closing. In the Antler residency. One paying enterprise customer live, multiple in pipeline.
              </li>
            </ul>
          </div>
        </section>

        {/* Apply */}
        <section className="px-6 py-12 bg-[#F8FAFC] border-y border-[#E2E8F0] scroll-mt-8">
          <div className="max-w-3xl mx-auto">
            <h2 id="apply"
                className="text-3xl md:text-4xl font-bold text-[#0F172A] tracking-tight mb-4 scroll-mt-24">
              Apply
            </h2>
            <p className="text-[17px] text-[#334155] leading-[1.75] mb-8">
              Submit your application via the form linked below. We review every submission within 3 business days. Strong candidates get a 30-minute intro call within a week.
            </p>
            <ApplyButton applyUrl='https://settle.breezy.hr/p/5b63c2d35c46-co-founder-cto?state=published' label='Apply now' />
            <p className="text-sm text-[#64748B] mt-4">Opens in a new tab.</p>
          </div>
        </section>

        {/* How we work */}
        <section className="px-6 py-12">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-bold text-[#0F172A] tracking-tight mb-8">
              How we work
            </h2>
            <ul className="list-disc pl-6 space-y-2 text-[17px] text-[#334155] leading-[1.75]">
              <li>Investigation-first engineering — we read code before we change it</li>
              <li>Two-stop pattern: investigation report → implementation</li>
              <li>AI-augmented development — Cursor and Claude Code in the workflow</li>
              <li>Direct communication, no filler</li>
              <li>Ship frequently, validate with customers</li>
              <li>Correctness over novelty</li>
              <li>Enterprise-first — every architectural decision considers SOC 2, audit, RBAC</li>
            </ul>
          </div>
        </section>

      </main>
      <Footer />
    </>
  )
}
