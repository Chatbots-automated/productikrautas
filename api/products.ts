// api/products.ts  – Vercel Serverless Function (Node 18+)
import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUBCATEGORY_ID = 78          // keep only this sub-category
const TTL_MINUTES    = 10          // warm-lambda cache

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  console.log('----- /api/products called -----', new Date().toISOString())

  /* 0. env + method guards ------------------------------------------- */
  const { KENO_API_KEY = '' } = process.env
  if (!KENO_API_KEY) {
    console.error('❌  Missing KENO_API_KEY')
    return res.status(500).json({ error: 'Missing KENO_API_KEY env var' })
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  /* 1. simple warm-lambda cache -------------------------------------- */
  const cacheKey = `keno-lt-${SUBCATEGORY_ID}`
  const now      = Date.now()
  // @ts-ignore create bucket once
  if (!globalThis.__kenoCache) globalThis.__kenoCache = {}
  const cached = globalThis.__kenoCache[cacheKey]
  if (cached && now - cached.when < TTL_MINUTES * 60e3) {
    console.log('⚡ cache hit')
    return res
      .setHeader('X-Data-Source', 'cache')
      .status(200)
      .json(cached.data)
  }

  /* 2. fetch + filter ------------------------------------------------- */
  console.time('KENO fetch')
  try {
    const apiRes = await fetch('https://api.wycena.keno-energy.com', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        apikey: KENO_API_KEY,
        method: 'GetProductBase',
        parameters: [],
      }),
    })
    console.timeEnd('KENO fetch')
    console.log('KENO HTTP:', apiRes.status)

    if (!apiRes.ok) throw new Error(`KENO API ${apiRes.status}`)
    const raw = await apiRes.json()
    if (raw.errors) throw new Error(raw.errors)

    let total = 0
    const keep: any[] = []

    for (const p of raw.products_base as any[]) {
      total++
      p.description      = p.description?.lt      ?? null
      p.long_description = p.long_description?.lt ?? null
      if (+p.subcategory_id === SUBCATEGORY_ID) keep.push(p)
    }

    console.log(`raw: ${total}  kept: ${keep.length}`)
    if (keep[0]) console.log('first SKU:', keep[0].index)

    const payload = { connection_status: raw.connection_status, products_base: keep }
    globalThis.__kenoCache[cacheKey] = { data: payload, when: now }

    return res.status(200).json(payload)
  } catch (e: any) {
    console.error('❌  pipeline error:', e.message)
    return res.status(502).json({ error: e.message })
  }
}
