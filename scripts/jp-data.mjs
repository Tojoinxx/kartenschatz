// Builds jp/index.json + jp/sets/<set>.json: Japanese single cards (TCGplayer data via tcgcsv.com)
// with product id (→ picture) and US market price. Runs nightly as a GitHub Action – no dependencies.
import { mkdir, writeFile, rm } from 'node:fs/promises';

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

const ext = (p, name) => (p.extendedData || []).find((e) => e.name === name)?.value || null;
// "237/193" → "237", "001/SV-P" → "1", "SV-P 001" → "1", "TG05/TG30" → "TG5"
export function numKey(number) {
  const first = String(number || '').trim().split('/')[0].trim();
  const m = /^([A-Za-z-]*?)\s*0*(\d+)([A-Za-z]?)$/.exec(first.replace(/^(SV-P|S-P|SM-P|M-P)\s+/i, ''));
  return m ? (m[1] || '').toUpperCase() + m[2] + (m[3] || '').toLowerCase() : first.toUpperCase();
}
export const setKey = (g) => String(g.abbreviation || /^([^:]+):/.exec(g.name)?.[1] || g.groupId).trim().toLowerCase();

// English sealed products (category 3) – only products without a card number
async function sealedPricesEn(into) {
  const groups = (await json(`${BASE}/3/groups`))?.results || [];
  const queue = [...groups];
  async function worker() {
    for (let g; (g = queue.shift()); ) {
      const products = (await json(`${BASE}/3/${g.groupId}/products`).catch(() => null))?.results || [];
      const ids = new Set(products.filter((p) => !ext(p, 'Number')).map((p) => p.productId));
      if (!ids.size) continue;
      const prices = (await json(`${BASE}/3/${g.groupId}/prices`).catch(() => null))?.results || [];
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
  await writeFile(`${OUT}/sealed-prices.json`, JSON.stringify({ updated: index.updated, p: sealed }));
  console.log(`${Object.keys(sealed).length} sealed prices`);
  await writeFile(`${OUT}/index.json`, JSON.stringify(index));
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
