// api/products.ts – Vercel Serverless Function
import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUBCATEGORY_ID = 78          // current filter
const TTL_MINUTES    = 10

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  console.log('--- /api/products called', new Date().toISOString())

  /* env + method guards */
  const { KENO_API_KEY = '' } = process.env
  if (!KENO_API_KEY)
    return res.status(500).json({ error: 'Missing KENO_API_KEY env var' })
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  /* warm-lambda cache */
  const cacheKey = `keno-lt-${SUBCATEGORY_ID}`
  // @ts-ignore
  if (!globalThis.__kenoCache) globalThis.__kenoCache = {}
  const cached = globalThis.__kenoCache[cacheKey]
  if (cached && Date.now() - cached.when < TTL_MINUTES * 60_000) {
    console.log('⚡ cache hit')
    return res.setHeader('X-Data-Source', 'cache').status(200).json(cached.data)
  }

  const label = `KENO fetch ${Date.now()}`
  console.time(label)
  try {
    const apiRes = await fetch('https://api.wycena.keno-energy.com', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        apikey: KENO_API_KEY,
        method: 'GetProductBase',
        parameters: []
      })
    })
    console.timeEnd(label)
    if (!apiRes.ok) throw new Error(`KENO ${apiRes.status}`)
    const raw = await apiRes.json()
    if (raw.errors) throw new Error(raw.errors)

    /* scan & filter */
    const counts: Record<string, number> = {}
    const kept: any[] = []

    for (const p of raw.products_base as any[]) {
      const id = String(p.subcategory_id)
      counts[id] = (counts[id] || 0) + 1

      p.description      = p.description?.lt      ?? null
      p.long_description = p.long_description?.lt ?? null
      if (+p.subcategory_id === SUBCATEGORY_ID) kept.push(p)
    }

    /* diagnostics */
    console.log('Top 20 subcategory_id counts:')
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .forEach(([id, n]) => console.log(`  id ${id}: ${n}`))

    console.log(`Kept ${kept.length} rows where subcategory_id === ${SUBCATEGORY_ID}`)
    if (!kept.length) console.warn('❗ Pick a different ID from the list above.')

    const payload = { connection_status: raw.connection_status, products_base: kept }
    globalThis.__kenoCache[cacheKey] = { data: payload, when: Date.now() }
    return res.status(200).json(payload)
  } catch (e: any) {
    console.error('pipeline error:', e.message)
    return res.status(502).json({ error: e.message })
  }
}
