import Link from 'next/link'
import ScrollReveal from '@/components/ui/ScrollReveal'

export default function FinalCTA() {
  return (
    <section className="bg-slate-900 py-24 px-6 lg:px-12">
      <div className="max-w-xl mx-auto text-center">
        <ScrollReveal>
          <h2 className="text-4xl font-bold text-white tracking-tight mb-4">
            Bring autonomy to your next migration
          </h2>
          <p className="text-slate-400 text-base leading-relaxed mb-9">
            Tell us about your upcoming migration and we&apos;ll share a preliminary assessment within 48 hours.
          </p>

          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href="/request-access"
              className="bg-blue-600 hover:bg-blue-500 text-white font-semibold px-8 py-4 rounded-xl text-base shadow-lg shadow-blue-600/25 hover:-translate-y-0.5 transition-all"
            >
              Request Access
            </Link>
            <a
              href="https://calendly.com/mine-ai/demo"
              target="_blank"
              rel="noopener noreferrer"
              className="border border-slate-700 text-slate-300 font-medium px-8 py-4 rounded-xl text-base hover:border-slate-500 hover:text-white transition-all"
            >
              Book a Demo
            </a>
          </div>
        </ScrollReveal>
      </div>
    </section>
  )
}
