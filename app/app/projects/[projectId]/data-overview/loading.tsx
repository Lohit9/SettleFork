export default function DataOverviewLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b bg-white shrink-0">
        <div className="space-y-1.5">
          <div className="h-6 w-44 bg-gray-200 rounded" />
          <div className="h-4 w-60 bg-gray-100 rounded" />
        </div>
        <div className="h-9 w-28 bg-gray-100 rounded-lg" />
      </div>

      <div className="flex-1 overflow-auto">
        <div className="p-6 space-y-5 max-w-5xl mx-auto">
          {/* Dataset tabs */}
          <div className="flex gap-1 border-b">
            {[1, 2].map((i) => (
              <div key={i} className="h-9 w-32 bg-gray-100 rounded-t-lg" />
            ))}
          </div>

          {/* Table tabs */}
          <div className="flex gap-2 flex-wrap">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-8 w-28 bg-gray-100 rounded-lg" />
            ))}
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-2">
                <div className="h-3 w-20 bg-gray-100 rounded" />
                <div className="h-7 w-16 bg-gray-200 rounded" />
              </div>
            ))}
          </div>

          {/* Field table */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="divide-y divide-gray-100">
              {/* Header */}
              <div className="grid grid-cols-[2fr_1fr_1fr_1fr_80px] px-4 py-3 bg-gray-50 gap-4">
                {['Field Name', 'Type', 'Nullable', 'Key', 'Profile'].map((_, i) => (
                  <div key={i} className="h-4 w-20 bg-gray-200 rounded" />
                ))}
              </div>
              {/* Rows */}
              {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                <div key={i} className="grid grid-cols-[2fr_1fr_1fr_1fr_80px] px-4 py-3.5 gap-4 items-center">
                  <div className="h-4 bg-gray-200 rounded" style={{ width: `${40 + (i * 15) % 50}%` }} />
                  <div className="h-5 w-16 bg-gray-100 rounded-full" />
                  <div className="h-4 w-8 bg-gray-100 rounded" />
                  <div className="h-4 w-8 bg-gray-100 rounded" />
                  <div className="h-4 w-12 bg-gray-100 rounded" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
