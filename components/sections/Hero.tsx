'use client'

import Link from 'next/link'
import { useState, useEffect } from 'react'
import ScrollReveal from '@/components/ui/ScrollReveal'

const MIGRATION_SYSTEMS = [
  { name: 'Salesforce',             slug: 'Salesforce' },
  { name: 'SAP S/4HANA',            slug: 'SAP'        },
  { name: 'NetSuite',               slug: 'Netsuite'   },
  { name: 'HubSpot',                slug: 'Hubspot'    },
  { name: 'Microsoft Dynamics 365', slug: 'Dynamics'   },
  { name: 'Oracle',                 slug: 'Oracle'     },
] as const

const SOURCE_FIELDS = ['customer_id', 'cust_name', 'service_addr', 'acct_status']
const TARGET_FIELDS = ['AccountId', 'Account.Name', 'ServiceAddress__c', 'Status__c']

function HeroFlow() {
  const [step, setStep] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setStep((s) => (s + 1) % 4)
    }, 1800)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="bg-[#0F172A] rounded-2xl p-6 w-full shadow-2xl shadow-slate-900/40">
      {/* Title bar */}
      <div className="flex items-center gap-2 mb-6">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
          <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
        </div>
        <span className="text-[#64748B] text-xs ml-2 font-mono">
          settle — enterprise data migration
        </span>
      </div>

      {/* Flow grid */}
      <div className="grid grid-cols-[1fr_40px_1fr] gap-3 items-center mb-6">
        {/* Source fields */}
        <div className="space-y-2">
          {SOURCE_FIELDS.map((field, i) => (
            <div
              key={field}
              className={`font-mono text-xs px-3 py-1.5 rounded-md border transition-all duration-500 ${
                step >= 1
                  ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                  : 'border-slate-700 bg-slate-800/60 text-slate-600'
              }`}
              style={{ transitionDelay: `${i * 60}ms` }}
            >
              {field}
            </div>
          ))}
        </div>

        {/* Center connector */}
        <div className="flex flex-col items-center gap-1.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className={`rounded-full transition-all duration-300 ${
                step === 2
                  ? 'w-2 h-2 bg-blue-400 scale-125'
                  : 'w-1.5 h-1.5 bg-slate-700'
              }`}
              style={{ transitionDelay: `${i * 80}ms` }}
            />
          ))}
          <div
            className={`mt-1 text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded transition-all duration-300 ${
              step >= 1
                ? 'text-blue-300 bg-blue-500/20 border border-blue-500/30'
                : 'text-slate-600 bg-slate-800 border border-slate-700'
            }`}
          >
            Settle
          </div>
        </div>

        {/* Target fields */}
        <div className="space-y-2">
          {TARGET_FIELDS.map((field, i) => (
            <div
              key={field}
              className={`font-mono text-xs px-3 py-1.5 rounded-md border transition-all duration-500 ${
                step >= 3
                  ? 'border-teal-500/40 bg-teal-500/10 text-teal-300'
                  : 'border-slate-700 bg-slate-800/60 text-slate-600'
              }`}
              style={{ transitionDelay: `${i * 60}ms` }}
            >
              {field}
            </div>
          ))}
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-5 pt-4 border-t border-slate-800">
        <span
          className={`flex items-center gap-1.5 text-xs font-medium transition-colors duration-300 ${
            step >= 1 ? 'text-blue-400' : 'text-slate-600'
          }`}
        >
          <span className="text-[8px]">●</span> Profiled
        </span>
        <span
          className={`flex items-center gap-1.5 text-xs font-medium transition-colors duration-300 ${
            step >= 2 ? 'text-indigo-400' : 'text-slate-600'
          }`}
        >
          <span className="text-[8px]">●</span> Mapped
        </span>
        <span
          className={`flex items-center gap-1.5 text-xs font-medium transition-colors duration-300 ${
            step >= 3 ? 'text-teal-400' : 'text-slate-600'
          }`}
        >
          <span className="text-[8px]">●</span> Validated
        </span>
      </div>
    </div>
  )
}

export default function Hero() {
  return (
    <section className="pt-20 lg:pt-24 pb-10 lg:pb-12 bg-white">
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        <div className="grid lg:grid-cols-2 gap-14 items-center">

          {/* Left: Text */}
          <ScrollReveal>
            <p className="text-xs font-semibold uppercase tracking-widest text-[#2358D4] mb-4">
              AI-Native Data Migration
            </p>
            <h1 className="text-5xl lg:text-[3.25rem] font-bold text-[#0F172A] leading-[1.12] tracking-tight mb-5">
              Automate your entire data migration.
            </h1>
            <p className="hero-description text-lg text-[#475569] leading-relaxed max-w-lg mb-8">
              Settle is an AI-native platform that automates enterprise data migration — schema profiling, field mapping, transformations, and validation. Cut months to weeks. Catch errors before production.
            </p>

            <div className="flex flex-wrap gap-3 mb-3">
              <Link
                href="/request-access"
                className="bg-[#2358D4] hover:bg-[#1D4ED8] text-white font-semibold px-8 py-3.5 rounded-xl shadow-lg shadow-blue-600/20 hover:-translate-y-0.5 transition-all text-sm"
              >
                Request Access
              </Link>
              <a
                href="https://calendly.com/settle-ai/demo"
                target="_blank"
                rel="noopener noreferrer"
                className="border border-[#CBD5E1] text-[#0F172A] font-medium px-8 py-3.5 rounded-xl hover:border-[#2358D4] hover:text-[#2358D4] transition-all text-sm"
              >
                Book a Demo
              </a>
            </div>

            <p className="text-sm text-slate-400 mt-3">
              We review your migration scope and respond within 48 hours.
            </p>

            {/* Trust signals */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 pt-4 max-w-md">
              {[
                'AWS-hosted',
                'AES-256-GCM encryption',
                'Anthropic Enterprise LLMs',
                'SOC 2 in progress',
              ].map((badge) => (
                <span
                  key={badge}
                  className="flex items-center gap-1.5 text-xs text-[#94A3B8] font-medium"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-3 h-3 text-[#22C55E] shrink-0"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  {badge}
                </span>
              ))}
            </div>


          </ScrollReveal>

          {/* Right: Animated product demo */}
          <ScrollReveal delay={0.15}>
            <HeroFlow />
            <p className="text-sm text-[#64748B] text-center mt-4">
              Built by a former Deloitte enterprise data migration lead.
            </p>
          </ScrollReveal>
        </div>

        {/* Logo bar */}
        <ScrollReveal delay={0.1}>
          <div className="mt-16">
            <p className="text-center text-xs uppercase tracking-widest text-[#94A3B8] mb-5">
              Designed for migrations to
            </p>
            <div className="flex flex-wrap justify-center gap-12">
              {MIGRATION_SYSTEMS.map(({ name, slug }) => (
                <Link
                  key={name}
                  href={`/migrate?target=${slug}`}
                  className="text-sm font-bold text-[#0F172A] opacity-30 hover:opacity-60 transition-opacity tracking-tight cursor-pointer"
                >
                  {name}
                </Link>
              ))}
            </div>

            <Link
              href="/migrate"
              className="block text-center text-xs text-[#94A3B8] hover:text-[#2358D4] transition-colors mt-5"
            >
              View all 100+ migration paths →
            </Link>

          </div>
        </ScrollReveal>
      </div>
    </section>
  )
}
