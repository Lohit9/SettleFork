export default function ControlPlaneLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b bg-white shrink-0">
        <div className="space-y-1.5">
          <div className="h-6 w-40 bg-gray-200 rounded" />
          <div className="h-4 w-56 bg-gray-100 rounded" />
        </div>
        <div className="h-9 w-32 bg-gray-100 rounded-lg" />
      </div>

      <div className="flex-1 overflow-auto">
        <div className="p-6 space-y-6 max-w-4xl mx-auto">
          {/* Dataset cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {[1, 2].map((i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1.5">
                    <div className="h-5 w-32 bg-gray-200 rounded" />
                    <div className="h-4 w-20 bg-gray-100 rounded" />
                  </div>
                  <div className="h-7 w-7 bg-gray-100 rounded-full" />
                </div>
                <div className="space-y-2">
                  {[1, 2, 3].map((j) => (
                    <div key={j} className="flex items-center justify-between py-1.5 border-t border-gray-100">
                      <div className="h-4 bg-gray-100 rounded" style={{ width: `${35 + (j * 17) % 35}%` }} />
                      <div className="h-4 w-16 bg-gray-100 rounded" />
                    </div>
                  ))}
                </div>
                <div className="h-9 w-full bg-gray-100 rounded-lg" />
              </div>
            ))}
          </div>

          {/* Schema review section */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
            <div className="h-5 w-36 bg-gray-200 rounded" />
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-3 py-2 border-t border-gray-100">
                  <div className="h-4 w-4 bg-gray-200 rounded shrink-0" />
                  <div className="h-4 bg-gray-100 rounded flex-1" style={{ width: `${40 + (i * 11) % 45}%` }} />
                  <div className="h-5 w-16 bg-gray-100 rounded-full shrink-0" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
