export default function ControlPlaneLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      <div className="bg-white border-b border-gray-100 pl-2 pr-6 min-h-[60px] flex items-center gap-4">
        <div className="h-4 w-28 bg-gray-100 rounded" />
        <div className="w-px h-4 bg-gray-100" />
        <div className="h-3 w-28 bg-gray-100 rounded" />
      </div>
      <div className="flex-1 overflow-auto bg-gray-50 p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-3 h-60">
            <div className="h-4 w-28 bg-gray-100 rounded" />
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-gray-50 rounded" />
            ))}
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-3 h-60">
            <div className="h-4 w-28 bg-gray-100 rounded" />
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-gray-50 rounded" />
            ))}
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-5 h-32">
          <div className="h-4 w-40 bg-gray-100 rounded" />
        </div>
      </div>
    </div>
  )
}
