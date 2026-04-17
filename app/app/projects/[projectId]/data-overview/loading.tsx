export default function DataOverviewLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      <div className="bg-white border-b border-gray-100 pl-2 pr-6 min-h-[60px] flex items-center gap-4">
        <div className="h-4 w-28 bg-gray-100 rounded" />
        <div className="w-px h-4 bg-gray-100" />
        <div className="h-3 w-28 bg-gray-100 rounded" />
      </div>
      <div className="border-b border-gray-100 bg-white px-5 flex gap-6 py-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-4 w-24 bg-gray-100 rounded" />
        ))}
      </div>
      <div className="flex-1 overflow-auto bg-gray-50 p-5">
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-3">
            <div className="h-4 w-28 bg-gray-100 rounded" />
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="h-3 w-28 bg-gray-50 rounded" />
                <div className="h-3 w-16 bg-gray-50 rounded" />
              </div>
            ))}
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-3">
            <div className="h-4 w-28 bg-gray-100 rounded" />
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="h-3 w-36 bg-gray-50 rounded" />
                <div className="h-3 w-16 bg-gray-50 rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
