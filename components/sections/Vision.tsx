import ScrollReveal from '@/components/ui/ScrollReveal'

const FLYWHEEL = [
  { n: '1st',   label: 'migration', desc: 'Baseline schema intelligence' },
  { n: '10th',  label: 'migration', desc: 'Pattern library compounds' },
  { n: '100th', label: 'migration', desc: 'Near-autonomous execution' },
]

export default function Vision() {
  return (
    <section className="py-14 px-6 lg:px-12">
      <div className="max-w-3xl mx-auto text-center">

        {/* Header */}
        <ScrollReveal>
          <h2 className="text-4xl font-bold text-[#0F172A] tracking-tight mb-3">
            The vision
          </h2>
          <p className="text-[#64748B] text-lg mb-6">
            Migration as a reusable product, not a one-off project.
          </p>
        </ScrollReveal>

        {/* Flywheel cards */}
        <ScrollReveal delay={0.1}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {FLYWHEEL.map((item) => (
              <div
                key={item.n}
                className="bg-[#F8FAFC] rounded-xl p-5 border border-[#E2E8F0] hover:-translate-y-1 hover:shadow-lg transition-all duration-300"
              >
                <div className="text-2xl font-bold text-[#2358D4] tracking-tight leading-none">
                  {item.n}
                </div>
                <div className="text-[#64748B] text-sm mb-2">{item.label}</div>
                <div className="text-[#334155] text-sm">{item.desc}</div>
              </div>
            ))}
          </div>
        </ScrollReveal>

      </div>
    </section>
  )
}
