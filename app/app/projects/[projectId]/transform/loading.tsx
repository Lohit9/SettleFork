export default function TransformLoading() {
  return (
    <div className="flex h-full animate-pulse">
      {/* Sidebar */}
      <div className="w-72 border-r bg-white flex flex-col shrink-0">
        <div className="px-4 py-3 border-b space-y-2">
          <div className="h-5 w-36 bg-gray-200 rounded" />
          <div className="h-4 w-24 bg-gray-100 rounded" />
        </div>
        <div className="flex-1 overflow-auto p-3 space-y-1.5">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="flex items-center gap-2.5 px-2 py-2 rounded-lg">
              <div className="h-4 w-4 bg-gray-200 rounded shrink-0" />
              <div className="h-4 bg-gray-100 rounded flex-1" style={{ width: `${50 + (i * 13) % 40}%` }} />
              <div className="h-5 w-14 bg-gray-100 rounded-full shrink-0" />
            </div>
          ))}
        </div>
        <div className="p-4 border-t">
          <div className="h-9 w-full bg-gray-100 rounded-lg" />
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b bg-white shrink-0">
          <div className="space-y-1.5">
            <div className="h-6 w-48 bg-gray-200 rounded" />
            <div className="h-4 w-72 bg-gray-100 rounded" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-9 w-32 bg-gray-100 rounded-lg" />
            <div className="h-9 w-36 bg-gray-100 rounded-lg" />
          </div>
        </div>

        <div className="flex-1 p-6 space-y-4">
          {/* Field details card */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
            <div className="h-5 w-40 bg-gray-200 rounded" />
            <div className="grid grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-gray-50 rounded-lg p-3 space-y-2">
                  <div className="h-3 w-20 bg-gray-200 rounded" />
                  <div className="h-5 w-28 bg-gray-100 rounded" />
                </div>
              ))}
            </div>
          </div>

          {/* SQL editor area */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="h-5 w-32 bg-gray-200 rounded" />
              <div className="h-8 w-24 bg-gray-100 rounded-lg" />
            </div>
            <div className="h-40 bg-gray-50 rounded-lg border border-gray-100" />
          </div>
        </div>
      </div>
    </div>
  )
}
