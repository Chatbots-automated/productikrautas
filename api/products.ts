// api/products.ts – Vercel Serverless Function (Node 18+)
import type { VercelRequest, VercelResponse } from '@vercel/node'

const TARGET_NAME   = 'Energy storage'   // substring to auto-match
const TTL_MINUTES   = 10                 // product payload cache (min)
const CAT_TTL_MIN   = 60                 // category-tree cache  (min)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('--- /api/products called', new Date().toISOString())

  /* env / method guards */
  const { KENO_API_KEY = '' } = process.env
  if (!KENO_API_KEY) return res.status(500).json({ error: 'Missing KENO_API_KEY' })
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end() }

  /* warm bucket */
  // @ts-ignore
  if (!globalThis.__kenoCache) globalThis.__kenoCache = {}

  /* -------------------------------------------------------------- */
  /* 1. Fetch (or cache-hit) the category tree                      */
  /* -------------------------------------------------------------- */
  const catKey = 'keno-category-tree'
  let catsJson: any

  if (globalThis.__kenoCache[catKey] &&
      Date.now() - globalThis.__kenoCache[catKey].when < CAT_TTL_MIN * 60_000) {
    catsJson = globalThis.__kenoCache[catKey].data
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

  /* flatten + LOG every node */
  type Flat = { id: number; name: string; parent: number|null }
  const flat: Flat[] = []

  const walk = (node: any, parent: number|null) => {
    const entry = { id: +node.id, name: node.name, parent }
    flat.push(entry)
    console.log(`id ${entry.id} – ${entry.name}`)
    node.subcategories?.forEach((sub: any) => walk(sub, entry.id))
  }
  catsJson.categories?.forEach((c: any) => walk(c, null))

  /* return tree if requested ------------------------------------- */
  if (req.query.categories === '1') {
    return res.status(200).json({ categories: flat })
  }

  /* auto-match IDs via TARGET_NAME -------------------------------- */
  const matchedIds = flat
    .filter(c => c.name.toLowerCase().includes(TARGET_NAME.toLowerCase()))
    .map(c => c.id)

  console.log(`🔍 matched IDs for "${TARGET_NAME}":`, matchedIds)

  if (!matchedIds.length) {
    console.warn('❗ Nothing matched. Call ?categories=1 and pick an id.')
    return res.status(200).json({ connection_status: 'Success', products_base: [] })
  }

  /* -------------------------------------------------------------- */
  /* 2. warm-lambda cache for product payload                       */
  /* -------------------------------------------------------------- */
  const prodKey = `keno-products-${matchedIds.join('-')}`
  if (globalThis.__kenoCache[prodKey] &&
      Date.now() - globalThis.__kenoCache[prodKey].when < TTL_MINUTES * 60_000) {
    console.log('⚡ product cache hit')
    return res
      .setHeader('X-Data-Source', 'cache')
      .status(200)
      .json(globalThis.__kenoCache[prodKey].data)
  }

  /* -------------------------------------------------------------- */
  /* 3. Fetch product base, strip to LT, filter                     */
  /* -------------------------------------------------------------- */
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
