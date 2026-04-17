export default function OutputsLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      <div className="bg-white border-b border-gray-100 pl-2 pr-6 min-h-[60px] flex items-center gap-4">
        <div className="h-4 w-32 bg-gray-100 rounded" />
        <div className="w-px h-4 bg-gray-100" />
        <div className="h-3 w-28 bg-gray-100 rounded" />
      </div>
      <div className="flex-1 overflow-auto p-5 space-y-4">
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white border border-gray-200 rounded-lg p-5 h-32 space-y-2">
              <div className="h-3 w-28 bg-gray-100 rounded" />
              <div className="h-6 w-16 bg-gray-100 rounded" />
              <div className="h-3 w-20 bg-gray-50 rounded" />
            </div>
          ))}
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-5 h-48">
          <div className="h-4 w-48 bg-gray-100 rounded mb-4" />
          <div className="h-3 w-full bg-gray-50 rounded mb-2" />
          <div className="h-3 w-3/4 bg-gray-50 rounded" />
        </div>
      </div>
    </div>
  )
}
