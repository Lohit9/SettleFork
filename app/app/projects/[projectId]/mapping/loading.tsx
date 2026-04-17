export default function MappingLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      <div className="bg-white border-b border-gray-100 pl-2 pr-6 min-h-[60px] flex items-center gap-4">
        <div className="h-4 w-20 bg-gray-100 rounded" />
        <div className="w-px h-4 bg-gray-100" />
        <div className="h-3 w-28 bg-gray-100 rounded" />
      </div>
      <div className="flex items-center gap-3 px-5 py-2 bg-white">
        <div className="flex items-center gap-2 mr-4 pr-4 border-r border-gray-100">
          <div className="h-3 w-16 bg-gray-100 rounded" />
          <div className="h-3 w-3 bg-gray-100 rounded" />
          <div className="h-3 w-16 bg-gray-100 rounded" />
        </div>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-1.5 px-3">
            <div className="h-3 w-14 bg-gray-100 rounded" />
            <div className="h-4 w-6 bg-gray-100 rounded" />
          </div>
        ))}
      </div>
      <div className="bg-white border-b border-gray-100 px-5 py-2.5 flex items-center gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 w-24 bg-gray-100 rounded" />
        ))}
        <div className="h-8 w-32 bg-gray-100 rounded" />
        <div className="flex-1" />
        <div className="h-3 w-16 bg-gray-100 rounded" />
      </div>
      <div className="flex-1 overflow-auto bg-gray-50 p-5 space-y-2">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="bg-white border border-gray-200 rounded-lg h-20 flex items-center px-5 justify-between">
            <div className="h-4 w-32 bg-gray-100 rounded" />
            <div className="h-4 w-4 bg-gray-100 rounded" />
            <div className="h-4 w-36 bg-gray-100 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}
