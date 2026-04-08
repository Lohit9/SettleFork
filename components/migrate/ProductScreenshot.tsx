'use client'

import { useState } from 'react'
import Image from 'next/image'

interface ProductScreenshotProps {
  sourceSystem: string
  targetSystem: string
}

export default function ProductScreenshot({ sourceSystem, targetSystem }: ProductScreenshotProps) {
  const [imageError, setImageError] = useState(false)

  return (
    <div className="rounded-2xl overflow-hidden shadow-2xl border border-settle-slate-200">
      {/* Top bar */}
      <div className="h-9 bg-settle-slate-100 flex items-center px-3 gap-1.5 border-b border-settle-slate-200">
        <span className="w-2.5 h-2.5 rounded-full bg-[#EF4444]" />
        <span className="w-2.5 h-2.5 rounded-full bg-[#F59E0B]" />
        <span className="w-2.5 h-2.5 rounded-full bg-[#22C55E]" />
        <span className="text-settle-slate-400 text-[11px] ml-2">
          {sourceSystem} → {targetSystem} mapping
        </span>
      </div>

      {imageError ? (
        <div className="bg-settle-slate-50 p-8 flex items-center justify-center min-h-[200px]">
          <p className="text-settle-slate-400 text-sm text-center">
            Product preview — book a demo to see Settle in action
          </p>
        </div>
      ) : (
        <Image
          src="/images/product/mapping-review.png"
          alt={`Settle mapping review showing AI-generated field mappings with confidence scores for ${sourceSystem} to ${targetSystem} migration`}
          width={800}
          height={500}
          className="w-full h-auto"
          onError={() => setImageError(true)}
        />
      )}
    </div>
  )
}
