export default function MappingLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b bg-white shrink-0">
        <div className="space-y-1.5">
          <div className="h-6 w-36 bg-gray-200 rounded" />
          <div className="h-4 w-56 bg-gray-100 rounded" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-9 w-28 bg-gray-100 rounded-lg" />
          <div className="h-9 w-36 bg-gray-200 rounded-lg" />
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="p-6 space-y-5 max-w-5xl mx-auto">
          {/* Coverage bar */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="h-5 w-32 bg-gray-200 rounded" />
              <div className="h-5 w-16 bg-gray-100 rounded" />
            </div>
            <div className="h-2.5 bg-gray-100 rounded-full">
              <div className="h-2.5 w-3/5 bg-gray-200 rounded-full" />
            </div>
            <div className="flex items-center gap-4">
              <div className="h-4 w-24 bg-gray-100 rounded" />
              <div className="h-4 w-24 bg-gray-100 rounded" />
              <div className="h-4 w-24 bg-gray-100 rounded" />
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 border-b">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-9 w-28 bg-gray-100 rounded-t-lg" />
            ))}
          </div>

          {/* Mapping rows */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="grid grid-cols-[1fr_40px_1fr_120px] gap-0 divide-y divide-gray-100">
              {/* Header */}
              <div className="col-span-4 grid grid-cols-[1fr_40px_1fr_120px] px-4 py-3 bg-gray-50">
                <div className="h-4 w-24 bg-gray-200 rounded" />
                <div />
                <div className="h-4 w-24 bg-gray-200 rounded" />
                <div className="h-4 w-20 bg-gray-200 rounded" />
              </div>
              {/* Rows */}
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="col-span-4 grid grid-cols-[1fr_40px_1fr_120px] px-4 py-3.5 items-center">
                  <div className="space-y-1.5">
                    <div className="h-4 bg-gray-200 rounded" style={{ width: `${40 + (i * 17) % 45}%` }} />
                    <div className="h-3 bg-gray-100 rounded w-20" />
                  </div>
                  <div className="flex justify-center">
                    <div className="h-4 w-4 bg-gray-100 rounded-full" />
                  </div>
                  <div className="space-y-1.5">
                    <div className="h-4 bg-gray-200 rounded" style={{ width: `${35 + (i * 19) % 50}%` }} />
                    <div className="h-3 bg-gray-100 rounded w-20" />
                  </div>
                  <div className="flex justify-end pr-2">
                    <div className="h-6 w-20 bg-gray-100 rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
