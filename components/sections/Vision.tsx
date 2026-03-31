import ScrollReveal from '@/components/ui/ScrollReveal'

const FLYWHEEL = [
  { n: '1st',   label: 'migration', desc: 'Baseline schema intelligence' },
  { n: '10th',  label: 'migration', desc: 'Pattern library compounds' },
  { n: '100th', label: 'migration', desc: 'Near-autonomous execution' },
]

export default function Vision() {
  return (
    <section className="py-24 px-6 lg:px-12">
      <div className="max-w-3xl mx-auto text-center">

        {/* Header */}
        <ScrollReveal>
          <h2 className="text-4xl font-bold text-slate-900 tracking-tight mb-3">
            The vision
          </h2>
          <p className="text-slate-500 text-lg mb-10">
            Migration as a reusable product, not a one-off project.
          </p>
        </ScrollReveal>

        {/* Flywheel cards */}
        <ScrollReveal delay={0.1}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
            {FLYWHEEL.map((item) => (
              <div
                key={item.n}
                className="bg-slate-50 rounded-xl p-6 border border-slate-200 hover:-translate-y-1 hover:shadow-lg transition-all duration-300"
              >
                <div className="text-3xl font-bold text-blue-600 tracking-tight leading-none">
                  {item.n}
                </div>
                <div className="text-slate-500 text-sm mb-2">{item.label}</div>
                <div className="text-slate-700 text-sm">{item.desc}</div>
              </div>
            ))}
          </div>
        </ScrollReveal>

        {/* Pull quote */}
        <ScrollReveal delay={0.2}>
          <div className="bg-blue-50 rounded-xl p-7 border-l-4 border-l-blue-600 text-left">
            <p className="text-base text-slate-800 leading-relaxed italic">
              "Long-term, Mine becomes the autonomous layer that understands how data moves across your enterprise. Every mapping, fix, and transformation makes the platform smarter."
            </p>
          </div>
        </ScrollReveal>

      </div>
    </section>
  )
}
