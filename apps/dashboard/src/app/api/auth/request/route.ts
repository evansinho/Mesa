import { NextResponse } from 'next/server'
import { loadEnv } from '@/lib/load-env'

export async function POST(req: Request) {
  loadEnv()
  const body = await req.json()

  const apiUrl = process.env.MESA_API_URL || 'http://localhost:3002'
  const internalKey = process.env.INTERNAL_API_KEY || ''

  const res = await fetch(`${apiUrl}/auth/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mesa-api-key': internalKey,
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  return new NextResponse(text, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
  })
}
