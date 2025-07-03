// api/products.ts – Vercel Serverless Function (Node 18+)
import type { VercelRequest, VercelResponse } from '@vercel/node'

const TARGET_NAME   = 'Energy storage'   // substring to match
const TTL_MINUTES   = 10                 // product payload cache
const CAT_TTL_MIN   = 60                 // category-tree cache

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('--- /api/products called', new Date().toISOString())

  /* env / method guards */
  const { KENO_API_KEY = '' } = process.env
  if (!KENO_API_KEY) return res.status(500).json({ error: 'Missing KENO_API_KEY' })
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end() }

  // global warm cache bucket
  // @ts-ignore
  if (!globalThis.__kenoCache) globalThis.__kenoCache = {}

  /* ------------------------------------------------------------------ */
  /* 1. FETCH (or cache-hit) category tree                             */
  /* ------------------------------------------------------------------ */
  const catKey   = 'keno-category-tree'
  const catCache = globalThis.__kenoCache[catKey]
  let catsJson: any

  if (catCache && Date.now() - catCache.when < CAT_TTL_MIN * 60_000) {
    catsJson = catCache.data
    console.log('📁 category cache hit')
  } else {
    console.time('GetProductCategories')
    const catRes = await fetch('https://api.wycena.keno-energy.com', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ apikey: KENO_API_KEY, method: 'GetProductCategories', parameters: [] })
    })
    console.timeEnd('GetProductCategories')
    if (!catRes.ok) return res.status(502).json({ error: 'GetProductCategories ' + catRes.status })
    catsJson = await catRes.json()
    globalThis.__kenoCache[catKey] = { data: catsJson, when: Date.now() }
  }

  /* flatten tree for easy reading */
  type FlatCat = { id: number; name: string; parent: number|null }
  const flat: FlatCat[] = []

  const walk = (node: any, parent: number|null) => {
    flat.push({ id: +node.id, name: node.name, parent })
    node.subcategories?.forEach((sub: any) => walk(sub, +node.id))
  }
  catsJson.categories?.forEach((c: any) => walk(c, null))

  /* quick log of first 30 */
  console.log('Sample categories:', flat.slice(0, 30).map(c => `${c.id}:${c.name}`).join(' | '))

  /* ------------------------------------------------------------------ */
  /* 2. If ?categories=1, return the list and stop here                 */
  /* ------------------------------------------------------------------ */
  if (req.query.categories === '1') {
    return res.status(200).json({ categories: flat })
  }

  /* ------------------------------------------------------------------ */
  /* 3. Determine IDs matching TARGET_NAME                              */
  /* ------------------------------------------------------------------ */
  const matchedIds = flat
    .filter(c => c.name.toLowerCase().includes(TARGET_NAME.toLowerCase()))
    .map(c => c.id)

  console.log(`🔍 matched IDs for "${TARGET_NAME}":`, matchedIds)

  if (!matchedIds.length) {
    console.warn('❗ No IDs matched – return empty product list. Hit ?categories=1 to inspect.')
    return res.status(200).json({ connection_status: 'Success', products_base: [] })
  }

  /* ------------------------------------------------------------------ */
  /* 4. warm-lambda cache for product payload                           */
  /* ------------------------------------------------------------------ */
  const prodKey   = `keno-products-${matchedIds.join('-')}`
  const prodCache = globalThis.__kenoCache[prodKey]
  if (prodCache && Date.now() - prodCache.when < TTL_MINUTES * 60_000) {
    console.log('⚡ product cache hit')
    return res.setHeader('X-Data-Source', 'cache').status(200).json(prodCache.data)
  }

  /* ------------------------------------------------------------------ */
  /* 5. Fetch product base, strip to LT, filter                        */
  /* ------------------------------------------------------------------ */
  console.time('GetProductBase')
  try {
    const apiRes = await fetch('https://api.wycena.keno-energy.com', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ apikey: KENO_API_KEY, method: 'GetProductBase', parameters: [] })
    })
    console.timeEnd('GetProductBase')
    if (!apiRes.ok) throw new Error('GetProductBase ' + apiRes.status)
    const raw = await apiRes.json()
    if (raw.errors) throw new Error(raw.errors)

    const kept = raw.products_base
      .filter((p: any) => matchedIds.includes(+p.subcategory_id))
      .map((p: any) => ({
        ...p,
        description     : p.description?.lt ?? null,
        long_description: p.long_description?.lt ?? null
      }))

    console.log(`Kept ${kept.length} rows in IDs [${matchedIds.join(', ')}]`)

    const payload = { connection_status: raw.connection_status, products_base: kept }
    globalThis.__kenoCache[prodKey] = { data: payload, when: Date.now() }
    return res.status(200).json(payload)
  } catch (e: any) {
    console.error('❌ pipeline error:', e.message)
    return res.status(502).json({ error: e.message })
  }
}
