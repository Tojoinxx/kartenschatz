// Builds jp/index.json + jp/sets/<set>.json: Japanese single cards (TCGplayer data via tcgcsv.com)
// with product id (→ picture) and US market price. Runs nightly as a GitHub Action – no dependencies.
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { buildCatalog } from './sealed-catalog.mjs';

const BASE = process.env.TCGCSV_BASE || 'https://tcgcsv.com/tcgplayer';
const CAT = 85; // Pokémon Japan
const OUT = process.env.OUT_DIR || 'jp';
const headers = { 'User-Agent': 'kartenschatz-jp-data/1 (github action)' };

async function json(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch (e) {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw new Error('failed: ' + url);
}

const dump = { en: [], jp: [] };
const releaseOf = (p) => (p.presaleInfo?.isPresale && p.presaleInfo?.releasedOn ? String(p.presaleInfo.releasedOn).slice(0, 10) : null);
function addToDump(lang, g, sealedProducts) {
  if (!sealedProducts.length) return;
  dump[lang].push({
    g: g.groupId,
    n: g.name,
    a: g.abbreviation || '',
    d: (g.publishedOn || '').slice(0, 10),
    p: sealedProducts.map((p) => [p.productId, p.name, releaseOf(p)]),
  });
}
const ext = (p, name) => (p.extendedData || []).find((e) => e.name === name)?.value || null;
// "237/193" → "237", "001/SV-P" → "1", "SV-P 001" → "1", "TG05/TG30" → "TG5"
export function numKey(number) {
  const first = String(number || '').trim().split('/')[0].trim();
  const m = /^([A-Za-z-]*?)\s*0*(\d+)([A-Za-z]?)$/.exec(first.replace(/^(SV-P|S-P|SM-P|M-P)\s+/i, ''));
  return m ? (m[1] || '').toUpperCase() + m[2] + (m[3] || '').toLowerCase() : first.toUpperCase();
}
export const setKey = (g) => String(g.abbreviation || /^([^:]+):/.exec(g.name)?.[1] || g.groupId).trim().toLowerCase();

// English sealed products (category 3) – only products without a card number
const enCards = [];

/** Write jp/en/<tcgdex set id>.json for the English single cards (matched via TCGplayer group). */
async function writeEnCards() {
  const tpMap = JSON.parse(await readFile(new URL('./tcgplayer-sets.json', import.meta.url), 'utf8').catch(() => '{}'));
  const enSets = (await json(`${process.env.TCGDEX_BASE || 'https://api.tcgdex.net/v2'}/en/sets`).catch(() => null)) || [];
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const byName = new Map(enSets.map((x) => [norm(x.name), x.id]));
  const out = {};
  for (const { g, c } of enCards) {
    const id = tpMap[String(g.groupId)] || byName.get(norm(g.name.replace(/^[A-Za-z0-9.\-]+:\s*/, ''))) || null;
    if (!id) continue;
    const prev = out[id] || {};
    for (const [k, list] of Object.entries(c)) prev[k] = [...(prev[k] || []), ...list];
    out[id] = prev;
  }
  await mkdir(`${OUT}/en`, { recursive: true });
  for (const [id, c] of Object.entries(out)) await writeFile(`${OUT}/en/${encodeURIComponent(id.toLowerCase())}.json`, JSON.stringify({ c }));
  await writeFile(`${OUT}/en/index.json`, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), sets: Object.fromEntries(Object.keys(out).map((id) => [id.toLowerCase(), 1])) }));
  console.log(`${Object.keys(out).length} english sets with card pictures`);
}

// Cardmarket publishes a product list and a price guide (EUR) as public files – use them for sealed
// products so displays and ETBs get European prices instead of US ones.
const CM = process.env.CM_BASE || 'https://downloads.s3.cardmarket.com/productCatalog';
async function cardmarketSealed() {
  const status = { at: new Date().toISOString() };
  const [list, guide] = await Promise.all([
    json(`${CM}/productList/products_nonsingles_6.json`, 2).catch((e) => ((status.listError = e.message), null)),
    json(`${CM}/priceGuide/price_guide_6.json`, 2).catch((e) => ((status.guideError = e.message), null)),
  ]);
  const products = list?.products || list?.items || (Array.isArray(list) ? list : null);
  const guides = guide?.priceGuides || null;
  status.products = products?.length || 0;
  status.guides = guides?.length || 0;
  status.sample = products?.slice(0, 3) || null;
  if (!products?.length || !guides?.length) {
    await writeFile(`${OUT}/cm-status.json`, JSON.stringify(status));
    return;
  }
  const price = new Map(guides.map((g) => [g.idProduct, g]));
  const norm = (x) => String(x || '').toLowerCase().replace(/pok[eé]mon/g, '').replace(/\(exclusive\)/g, '').replace(/[^a-z0-9]/g, '');
  const byName = new Map();
  for (const p of products) {
    const k = norm(p.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  }
  const out = {};
  let matched = 0;
  for (const g of dump.en) {
    for (const [pid, name] of g.p) {
      const hits = byName.get(norm(name.replace(/^[A-Za-z0-9.\-]+:\s*/, ''))) || [];
      if (hits.length !== 1) continue;
      const pg = price.get(hits[0].idProduct);
      if (!pg) continue;
      const r = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : undefined);
      out[pid] = { id: hits[0].idProduct, t: r(pg.trend), a7: r(pg.avg7), a30: r(pg.avg30), l: r(pg.low) };
      matched++;
    }
  }
  status.matched = matched;
  await writeFile(`${OUT}/cm-status.json`, JSON.stringify(status));
  await writeFile(`${OUT}/cm-sealed.json`, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), p: out }));
  console.log(`cardmarket sealed prices: ${matched}`);
}

async function sealedPricesEn(into) {
  const groups = (await json(`${BASE}/3/groups`))?.results || [];
  const queue = [...groups];
  async function worker() {
    for (let g; (g = queue.shift()); ) {
      const products = (await json(`${BASE}/3/${g.groupId}/products`).catch(() => null))?.results || [];
      const sealedProducts = products.filter((p) => !ext(p, 'Number'));
      addToDump('en', g, sealedProducts);
      // single cards → picture fallback + TCGplayer price check for western cards
      const singles = products.filter((p) => ext(p, 'Number'));
      let cardPrices = null;
      if (singles.length) {
        cardPrices = (await json(`${BASE}/3/${g.groupId}/prices`).catch(() => null))?.results || [];
        const normal = new Map();
        const rev = new Map();
        for (const pr of cardPrices) {
          const v = pr.marketPrice ?? pr.midPrice ?? null;
          if (v == null) continue;
          const m = /reverse/i.test(pr.subTypeName || '') ? rev : normal;
          if (!m.has(pr.productId) || v > m.get(pr.productId)) m.set(pr.productId, v);
        }
        const c = {};
        for (const p of singles) {
          const k = numKey(ext(p, 'Number'));
          (c[k] = c[k] || []).push([p.productId, p.name, normal.get(p.productId) ?? null, rev.get(p.productId) ?? null]);
        }
        enCards.push({ g, c });
      }
      const ids = new Set(sealedProducts.map((p) => p.productId));
      if (!ids.size) continue;
      const prices = cardPrices || (await json(`${BASE}/3/${g.groupId}/prices`).catch(() => null))?.results || [];
      for (const p of prices) {
        const v = p.marketPrice ?? p.midPrice ?? null;
        if (v != null && ids.has(p.productId) && (into[p.productId] == null || v > into[p.productId])) into[p.productId] = v;
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
}

async function main() {
  const groups = (await json(`${BASE}/${CAT}/groups`))?.results || [];
  if (!groups.length) throw new Error('no groups');
  await rm(OUT, { recursive: true, force: true });
  await mkdir(`${OUT}/sets`, { recursive: true });
  const index = { updated: new Date().toISOString().slice(0, 10), source: 'TCGplayer via tcgcsv.com', sets: {} };
  let cards = 0;
  const sealed = {};
  const queue = [...groups];
  async function worker() {
    for (let g; (g = queue.shift()); ) {
      const products = (await json(`${BASE}/${CAT}/${g.groupId}/products`))?.results || [];
      const prices = (await json(`${BASE}/${CAT}/${g.groupId}/prices`))?.results || [];
      const price = new Map();
      for (const p of prices) {
        const v = p.marketPrice ?? p.midPrice ?? null;
        if (v != null && (!price.has(p.productId) || v > price.get(p.productId))) price.set(p.productId, v);
      }
      addToDump('jp', g, products.filter((p) => !ext(p, 'Number')));
      const c = {};
      for (const p of products) {
        const number = ext(p, 'Number');
        if (!number) {
          // sealed product → nightly price for the collection value
          if (price.has(p.productId)) sealed[p.productId] = price.get(p.productId);
          continue;
        }
        const k = numKey(number);
        (c[k] = c[k] || []).push([p.productId, p.name, price.get(p.productId) ?? null, ext(p, 'Rarity')]);
      }
      const n = Object.keys(c).length;
      if (!n) continue;
      const key = setKey(g);
      // two groups can share an abbreviation → merge
      const file = `${OUT}/sets/${encodeURIComponent(key)}.json`;
      const prev = index.sets[key];
      if (prev) {
        for (const [k, list] of Object.entries(prev.c)) c[k] = [...(c[k] || []), ...list];
      }
      index.sets[key] = { g: g.groupId, name: g.name, n: Object.keys(c).length, date: (g.publishedOn || '').slice(0, 10), c };
      await writeFile(file, JSON.stringify({ g: g.groupId, name: g.name, c }));
      cards += products.length;
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (const s of Object.values(index.sets)) delete s.c;
  await sealedPricesEn(sealed);
  await writeEnCards().catch((e) => console.warn('english cards failed', e.message));
  await cardmarketSealed().catch((e) => console.warn('cardmarket sealed failed', e.message));
  await writeFile(`${OUT}/sealed-prices.json`, JSON.stringify({ updated: index.updated, p: sealed }));
  console.log(`${Object.keys(sealed).length} sealed prices`);
  await writeFile(`${OUT}/index.json`, JSON.stringify(index));
  // sealed product catalog incl. upcoming sets (presales with release date)
  const catalog = await buildCatalog(dump).catch((e) => console.warn('catalog failed', e.message));
  if (catalog) {
    await writeFile(`${OUT}/sealed-catalog.json`, JSON.stringify(catalog));
    console.log(`catalog: ${catalog.g.length} groups, ${catalog.p.length} products, ${catalog.p.filter((p) => p[6]).length} upcoming`);
  }
  // exchange rate for the TCGplayer (USD) cross-check of Cardmarket prices
  try {
    const fx = await json(process.env.FX_URL || 'https://api.frankfurter.app/latest?from=USD&to=EUR', 2);
    if (fx?.rates?.EUR) await writeFile(`${OUT}/fx.json`, JSON.stringify({ usdEur: fx.rates.EUR, date: fx.date }));
  } catch (e) {
    console.warn('no exchange rate', e.message);
  }
  console.log(`${Object.keys(index.sets).length} sets, ${cards} products`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
