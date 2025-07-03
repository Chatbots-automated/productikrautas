// api/products.ts – Vercel Serverless Function (Node 18+)
import type { VercelRequest, VercelResponse } from '@vercel/node'

/** Storage category & its direct children */
const STORAGE_IDS = [78, 218, 219, 220, 269]  // top + accessories/modules/ctrl/warranty
const TTL_MINUTES = 10                       // product payload cache (minutes)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('--- /api/products called', new Date().toISOString())

  /* guards */
  const { KENO_API_KEY = '' } = process.env
  if (!KENO_API_KEY) return res.status(500).json({ error: 'Missing KENO_API_KEY' })
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end() }

  // quick sanity endpoint
  if (req.query.ids === '1') return res.status(200).json({ ids: STORAGE_IDS })

  /* warm cache bucket */
  // @ts-ignore
  if (!globalThis.__kenoCache) globalThis.__kenoCache = {}
  const cacheKey = `keno-products-${STORAGE_IDS.join('-')}`
  const cached   = globalThis.__kenoCache[cacheKey]
  if (cached && Date.now() - cached.when < TTL_MINUTES * 60_000) {
    console.log('⚡ cache hit')
    return res.setHeader('X-Data-Source', 'cache').status(200).json(cached.data)
  }

  /* fetch product base ------------------------------------------------ */
  console.time('GetProductBase')
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
    console.timeEnd('GetProductBase')
    if (!apiRes.ok) throw new Error('GetProductBase ' + apiRes.status)
    const raw = await apiRes.json()
    if (raw.errors) throw new Error(raw.errors)

    /* keep only storage-related SKUs, strip to LT */
    const kept = raw.products_base
      .filter((p: any) => STORAGE_IDS.includes(+p.subcategory_id))
      .map((p: any) => ({
        ...p,
        description     : p.description?.lt      ?? null,
        long_description: p.long_description?.lt ?? null
      }))

    console.log(`Kept ${kept.length} rows for IDs [${STORAGE_IDS.join(', ')}]`)

    const payload = { connection_status: raw.connection_status, products_base: kept }
    globalThis.__kenoCache[cacheKey] = { data: payload, when: Date.now() }

    return res.status(200).json(payload)
  } catch (e: any) {
    console.error('❌ pipeline error:', e.message)
    return res.status(502).json({ error: e.message })
  }
}
