export default function TransformLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      <div className="bg-white border-b border-gray-100 pl-2 pr-6 min-h-[60px] flex items-center gap-4">
        <div className="h-4 w-24 bg-gray-100 rounded" />
        <div className="w-px h-4 bg-gray-100" />
        <div className="h-3 w-28 bg-gray-100 rounded" />
        <div className="flex-1" />
        <div className="h-8 w-44 bg-gray-100 rounded" />
        <div className="h-8 w-28 bg-primary/20 rounded" />
      </div>
      <div className="flex items-center gap-3 px-5 py-2 bg-white">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-1.5 px-3">
            <div className="h-3 w-14 bg-gray-100 rounded" />
            <div className="h-4 w-6 bg-gray-100 rounded" />
          </div>
        ))}
      </div>
      <div className="bg-white border-b border-gray-100 px-5 py-2.5 flex items-center gap-4">
        {[1, 2].map((i) => (
          <div key={i} className="h-8 w-24 bg-gray-100 rounded" />
        ))}
        <div className="h-8 w-32 bg-gray-100 rounded" />
      </div>
      <div className="flex-1 flex bg-gray-50 overflow-hidden">
        <div className="w-[320px] border-r border-gray-100 bg-white p-3 space-y-2">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="h-10 bg-gray-50 rounded" />
          ))}
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="w-14 h-14 bg-gray-100 rounded-full mx-auto" />
            <div className="h-4 w-40 bg-gray-100 rounded mx-auto" />
            <div className="h-3 w-56 bg-gray-100 rounded mx-auto" />
          </div>
        </div>
      </div>
    </div>
  )
}
