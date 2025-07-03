// api/products.ts – Vercel Serverless Function (Node 18+)
import type { VercelRequest, VercelResponse } from '@vercel/node'

const TARGET_NAME   = 'Energy storage'   // what we look for in category names
const TTL_MINUTES   = 10                 // warm cache for product payload
const CAT_TTL_MIN   = 60                 // cache category tree for 1 h

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  console.log('--- /api/products called', new Date().toISOString())

  const { KENO_API_KEY = '' } = process.env
  if (!KENO_API_KEY)
    return res.status(500).json({ error: 'Missing KENO_API_KEY env var' })
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  // ---------- tiny global cache bucket ----------
  // @ts-ignore
  if (!globalThis.__kenoCache) globalThis.__kenoCache = {}

  /* 1. Get & cache the category tree ------------------------------- */
  const catKey = 'keno-category-tree'
  const catCache = globalThis.__kenoCache[catKey]
  let matchedIds: number[] = []

  if (catCache && Date.now() - catCache.when < CAT_TTL_MIN * 60_000) {
    matchedIds = catCache.ids
    console.log('📁 category cache hit:', matchedIds)
  } else {
    console.time('GetProductCategories')
    const catRes = await fetch('https://api.wycena.keno-energy.com', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        apikey: KENO_API_KEY,
        method: 'GetProductCategories',
        parameters: []
      })
    })
    console.timeEnd('GetProductCategories')
    if (!catRes.ok) {
      console.error('Failed to fetch categories:', catRes.status)
    } else {
      const cats = await catRes.json()
      const ids: number[] = []

      const touch = (obj: any) => {
        if (obj?.name?.toLowerCase().includes(TARGET_NAME.toLowerCase()))
          ids.push(+obj.id)
        if (Array.isArray(obj?.subcategories))
          obj.subcategories.forEach(touch)
      }
      cats.categories?.forEach(touch)

      matchedIds = ids
      globalThis.__kenoCache[catKey] = { ids, when: Date.now() }
    }
    console.log('🔍 matched IDs for', TARGET_NAME, ':', matchedIds)
  }

  if (!matchedIds.length) {
    console.warn('❗ No category IDs matched “' + TARGET_NAME + '” – returning empty list.')
  }

  /* 2. warm-lambda cache for product payload ---------------------- */
  const prodKey = `keno-products-${matchedIds.join('-') || 'none'}`
  const prodCache = globalThis.__kenoCache[prodKey]
  if (prodCache && Date.now() - prodCache.when < TTL_MINUTES * 60_000) {
    console.log('⚡ product cache hit')
    return res
      .setHeader('X-Data-Source', 'cache')
      .status(200)
      .json(prodCache.data)
  }

  /* 3. Fetch full product base ------------------------------------ */
  const label = `GetProductBase ${Date.now()}`
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

    /* 4. Strip to LT + filter by matched IDs ---------------------- */
    const kept: any[] = []
    for (const p of raw.products_base as any[]) {
      p.description      = p.description?.lt      ?? null
      p.long_description = p.long_description?.lt ?? null
      if (matchedIds.includes(+p.subcategory_id)) kept.push(p)
    }

    console.log(`Kept ${kept.length} rows in categories [${matchedIds.join(', ')}]`)

    const payload = { connection_status: raw.connection_status, products_base: kept }
    globalThis.__kenoCache[prodKey] = { data: payload, when: Date.now() }

    return res.status(200).json(payload)
  } catch (e: any) {
    console.error('❌ pipeline error:', e.message)
    return res.status(502).json({ error: e.message })
  }
}
