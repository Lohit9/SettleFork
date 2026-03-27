export default function ValidateLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b bg-white shrink-0">
        <div className="space-y-1.5">
          <div className="h-6 w-40 bg-gray-200 rounded" />
          <div className="h-4 w-64 bg-gray-100 rounded" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-9 w-28 bg-gray-100 rounded-lg" />
          <div className="h-9 w-32 bg-gray-100 rounded-lg" />
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="p-6 space-y-5 max-w-5xl mx-auto">
          {/* Readiness dashboard */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-5">
            <div className="flex items-center gap-8">
              <div className="h-28 w-28 bg-gray-100 rounded-full shrink-0" />
              <div className="flex-1 flex items-center justify-around gap-4">
                <div className="flex flex-col items-center gap-2">
                  <div className="h-9 w-12 bg-gray-200 rounded" />
                  <div className="h-4 w-16 bg-gray-100 rounded" />
                </div>
                <div className="w-px h-10 bg-gray-200" />
                <div className="flex flex-col items-center gap-2">
                  <div className="h-9 w-12 bg-gray-200 rounded" />
                  <div className="h-4 w-16 bg-gray-100 rounded" />
                </div>
                <div className="w-px h-10 bg-gray-200" />
                <div className="flex flex-col items-center gap-2">
                  <div className="h-9 w-12 bg-gray-200 rounded" />
                  <div className="h-4 w-16 bg-gray-100 rounded" />
                </div>
              </div>
            </div>
          </div>

          {/* Filter bar */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 flex items-center gap-3">
            <div className="h-4 w-16 bg-gray-100 rounded" />
            <div className="h-8 w-24 bg-gray-100 rounded-lg" />
            <div className="w-px h-4 bg-gray-200" />
            <div className="h-4 w-16 bg-gray-100 rounded" />
            <div className="h-8 w-24 bg-gray-100 rounded-lg" />
            <div className="w-px h-4 bg-gray-200" />
            <div className="h-4 w-16 bg-gray-100 rounded" />
            <div className="h-8 w-24 bg-gray-100 rounded-lg" />
          </div>

          {/* Issue card skeletons */}
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3">
              <div className="flex items-center gap-3">
                <div className="h-5 w-5 bg-gray-200 rounded-full shrink-0" />
                <div className="h-5 w-56 bg-gray-200 rounded" />
                <div className="h-5 w-16 bg-red-100 rounded-full" />
                <div className="h-5 w-20 bg-gray-100 rounded-full" />
              </div>
              <div className="h-4 w-full bg-gray-100 rounded" />
              <div className="h-4 w-3/4 bg-gray-100 rounded" />
              <div className="flex items-center gap-2 pt-1">
                <div className="h-8 w-32 bg-gray-100 rounded-lg" />
                <div className="h-8 w-28 bg-gray-100 rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
