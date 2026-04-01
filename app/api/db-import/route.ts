export const maxDuration = 60 // requires Vercel Pro

import { saveConnectionAndIntrospect } from '@/lib/actions/db-connector'

export async function POST(request: Request) {
  try {
    const params = await request.json()

    // Validate required fields
    const required = ['projectId', 'role', 'datasetId', 'host', 'port', 'database', 'username', 'password', 'sslMode', 'selectedTables']
    for (const field of required) {
      if (params[field] === undefined || params[field] === null || params[field] === '') {
        return Response.json({ success: false, error: `Missing required field: ${field}` }, { status: 400 })
      }
    }

    if (!Array.isArray(params.selectedTables) || params.selectedTables.length === 0) {
      return Response.json({ success: false, error: 'selectedTables must be a non-empty array' }, { status: 400 })
    }

    const result = await saveConnectionAndIntrospect({
      projectId: String(params.projectId),
      role: params.role as 'source' | 'target',
      datasetId: String(params.datasetId),
      host: String(params.host),
      port: Number(params.port),
      database: String(params.database),
      username: String(params.username),
      password: String(params.password),
      sslMode: String(params.sslMode),
      selectedTables: params.selectedTables as string[],
    })

    return Response.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error during import'
    return Response.json({ success: false, error: message }, { status: 500 })
  }
}
