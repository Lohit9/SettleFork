import './tokens.css'

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <div className="mkt">{children}</div>
}
