const features = [
  {
    title: 'AI schema understanding',
    description: 'Agents scan source systems and infer business meaning.',
    icon: '🔍',
  },
  {
    title: 'Auto-mapping & transformation',
    description: 'Multi-agent reasoning proposes and refines field-level mappings.',
    icon: '🔄',
  },
  {
    title: 'Cleansing & standardization',
    description: 'Reusable rules for addresses, picklists, dedupe, and integrity.',
    icon: '✨',
  },
  {
    title: 'Auto-generated ETL',
    description: 'Production-ready SQL, Python, and API loaders.',
    icon: '⚡',
  },
  {
    title: 'Validation & reconciliation',
    description: 'Catch missing dependencies, rule breaks, and data drift early.',
    icon: '✅',
  },
  {
    title: 'Iterative loads & delta migration',
    description: 'Handle schema changes and remapped objects without starting from scratch.',
    icon: '🔄',
  },
]

export default function Features() {
  return (
    <section className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl lg:text-4xl font-bold text-slate-900 mb-4">
            Core capabilities
          </h2>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {features.map((feature, index) => (
            <div
              key={index}
              className="bg-slate-50 rounded-lg p-6 border border-slate-200 hover:border-blue-300 transition-colors"
            >
              <div className="text-3xl mb-3">{feature.icon}</div>
              <h3 className="text-lg font-bold text-slate-900 mb-2">
                {feature.title}
              </h3>
              <p className="text-slate-600 text-sm">
                {feature.description}
              </p>
            </div>
          ))}
        </div>

        <p className="text-center text-sm text-slate-500">
          Designed for Salesforce, SAP, Oracle, NetSuite, and modern data stacks.
        </p>
      </div>
    </section>
  )
}

