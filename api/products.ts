// api/products.ts – Vercel Serverless Function (Node 18+)
import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUBCATEGORY_ID = 78          // you can change this after diagnostics
const TTL_MINUTES    = 10

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  console.log('--- /api/products called', new Date().toISOString())

  /* 0. env + method guards ----------------------------------------- */
  const { KENO_API_KEY = '' } = process.env
  if (!KENO_API_KEY) {
    console.error('❌  Missing KENO_API_KEY')
    return res.status(500).json({ error: 'Missing KENO_API_KEY env var' })
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  /* 1. warm-lambda cache ------------------------------------------- */
  const cacheKey = `keno-lt-${SUBCATEGORY_ID}`
  // @ts-ignore warm cache bucket
  if (!globalThis.__kenoCache) globalThis.__kenoCache = {}
  const cached = globalThis.__kenoCache[cacheKey]
  if (cached && Date.now() - cached.when < TTL_MINUTES * 60_000) {
    console.log('⚡ cache hit – returning cached payload')
    return res.setHeader('X-Data-Source', 'cache').status(200).json(cached.data)
  }

  /* 2. fetch full product base ------------------------------------ */
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
    console.log('KENO HTTP status:', apiRes.status)

    if (!apiRes.ok) throw new Error(`KENO API ${apiRes.status}`)
    const raw = await apiRes.json()
    if (raw.errors) throw new Error(raw.errors)

    /* quick peek at raw keys */
    console.log('Raw top-level keys:', Object.keys(raw).join(', '))

    if (!Array.isArray(raw.products_base) || !raw.products_base.length) {
      console.warn('❗ raw.products_base is missing or empty')
      return res.status(200).json({ connection_status: raw.connection_status, products_base: [] })
    }

    console.log('Total rows received:', raw.products_base.length)

    /* 3. scan & filter with diagnostics ---------------------------- */
    const counts: Record<string, number> = {}
    const firstTenIds: string[] = []
    const kept: any[] = []

    for (const p of raw.products_base as any[]) {
      const id = String(p.subcategory_id)
      counts[id] = (counts[id] || 0) + 1
      if (firstTenIds.length < 10 && !firstTenIds.includes(id)) firstTenIds.push(id)

      p.description      = p.description?.lt      ?? null
      p.long_description = p.long_description?.lt ?? null
      if (+p.subcategory_id === SUBCATEGORY_ID) kept.push(p)
    }

    console.log('First 10 distinct subcategory_id values:', firstTenIds.join(', '))
    console.log('Top 20 subcategory_id counts (desc):')
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .forEach(([id, n]) => console.log(`  id ${id}: ${n}`))

    console.log(`Kept ${kept.length} rows where subcategory_id == ${SUBCATEGORY_ID}`)
    if (!kept.length) console.warn('❗ 0 rows kept — pick one of the IDs printed above.')

    /* 4. cache + respond ------------------------------------------- */
    const payload = { connection_status: raw.connection_status, products_base: kept }
    globalThis.__kenoCache[cacheKey] = { data: payload, when: Date.now() }

    return res.status(200).json(payload)
  } catch (e: any) {
    console.error('❌  pipeline error:', e.message)
    return res.status(502).json({ error: e.message })
  }
}
