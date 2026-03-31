export default function OutputsLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b bg-white shrink-0">
        <div className="space-y-1.5">
          <div className="h-6 w-44 bg-gray-200 rounded" />
          <div className="h-4 w-64 bg-gray-100 rounded" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-9 w-40 bg-gray-100 rounded-lg" />
          <div className="h-9 w-44 bg-blue-100 rounded-lg" />
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="p-6 space-y-6 max-w-5xl mx-auto">
          {/* Phase tracker */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-5">
            <div className="h-5 w-40 bg-gray-200 rounded mb-4" />
            <div className="flex items-center gap-0">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-center flex-1">
                  <div className="flex flex-col items-center gap-2 flex-1">
                    <div className="h-8 w-8 bg-gray-100 rounded-full" />
                    <div className="h-3 w-16 bg-gray-100 rounded" />
                  </div>
                  {i < 5 && <div className="h-0.5 flex-1 bg-gray-100 mx-1" />}
                </div>
              ))}
            </div>
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-2">
                <div className="h-3 w-24 bg-gray-100 rounded" />
                <div className="h-8 w-20 bg-gray-200 rounded" />
                <div className="h-3 w-28 bg-gray-100 rounded" />
              </div>
            ))}
          </div>

          {/* Activity log */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b bg-gray-50">
              <div className="h-5 w-32 bg-gray-200 rounded" />
            </div>
            <div className="divide-y divide-gray-100">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-start gap-3 px-5 py-3.5">
                  <div className="h-5 w-5 bg-gray-100 rounded-full mt-0.5 shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-4 bg-gray-200 rounded" style={{ width: `${45 + (i * 13) % 40}%` }} />
                    <div className="h-3 w-24 bg-gray-100 rounded" />
                  </div>
                  <div className="h-3 w-20 bg-gray-100 rounded shrink-0" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
