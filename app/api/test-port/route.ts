import { NextResponse } from 'next/server'
import net from 'net'

export async function GET() {
  // Test TCP connection to a known public MS SQL endpoint
  // Using Azure's public DNS as a connectivity check
  return new Promise<NextResponse>((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(5000)
    
    // Try connecting to a known reachable host on port 1433
    // We'll just check if the port is reachable from Vercel's network
    socket.connect(1433, 'sql-test.database.windows.net', () => {
      socket.destroy()
      resolve(NextResponse.json({ success: true, message: 'Port 1433 outbound is open' }))
    })
    
    socket.on('error', (err) => {
      socket.destroy()
      resolve(NextResponse.json({ success: false, error: err.message }))
    })
    
    socket.on('timeout', () => {
      socket.destroy()
      resolve(NextResponse.json({ success: false, error: 'Connection timed out on port 1433' }))
    })
  })
}