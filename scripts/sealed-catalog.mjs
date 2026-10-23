// Builds the sealed product catalog (displays, ETBs, tins …) from TCGplayer groups – nightly, so new and
// upcoming sets (presales with release date) show up automatically. Same format as the bundled sealed.json:
//   g: [groupId, displayName, nameEn|0, era|0, date, tcgdexSetId|0, 'en'|'jp']
//   p: [productId, groupIndex, type, nameEn, nameDe|0, era|0, releaseDate|0]
import { readFile } from 'node:fs/promises';

const TCGDEX = process.env.TCGDEX_BASE || 'https://api.tcgdex.net/v2';

const ERA_DATES = [
  ['1999-01-01', 'base'], ['2000-08-01', 'gym'], ['2000-12-01', 'neo'], ['2002-05-01', 'lc'],
  ['2002-09-01', 'ecard'], ['2003-06-01', 'ex'], ['2007-05-01', 'dp'], ['2009-02-01', 'pl'],
  ['2010-02-01', 'hgss'], ['2011-04-01', 'bw'], ['2014-02-01', 'xy'], ['2017-02-01', 'sm'],
  ['2020-02-01', 'swsh'], ['2023-03-15', 'sv'], ['2025-09-01', 'me'],
];
const ERA_DATES_JP = [
  ['1996-10-01', 'base'], ['1999-11-01', 'neo'], ['2001-07-01', 'ecard'], ['2002-11-01', 'ex'],
  ['2006-09-01', 'dp'], ['2009-07-01', 'hgss'], ['2010-09-01', 'bw'], ['2013-12-01', 'xy'],
  ['2016-12-01', 'sm'], ['2019-12-01', 'swsh'], ['2023-01-01', 'sv'], ['2025-08-01', 'me'],
];

function eraByDate(d, jp) {
  const table = jp ? ERA_DATES_JP : ERA_DATES;
  let era = table[0][1];
  for (const [start, e] of table) if (d >= start) era = e;
  return era;
}

function eraByName(name, jp) {
  if (jp) {
    const a = name.split(':')[0];
    for (const [rx, e] of [
      [/^(M\d|m\d|ME|MB|MF|mE|M-P|M\b)/, 'me'], [/^(SV|sv|WCS2[3-9])/, 'sv'], [/^SM/, 'sm'],
      [/^(S\d|S-P|s[A-Z])/, 'swsh'], [/^XY/, 'xy'], [/^BW/, 'bw'],
    ]) if (rx.test(a)) return e;
    return null;
  }
  for (const [rx, e] of [
    [/^ME\d*\b|^ME:/, 'me'], [/^SV\d*\b|^SV:/, 'sv'], [/^SWSH/, 'swsh'], [/^SM\b|^SM\d|^SM /, 'sm'],
    [/^XY\b/, 'xy'], [/^BW\b/, 'bw'], [/^HGSS/, 'hgss'], [/^DP\b/, 'dp'], [/^EX\b/, 'ex'],
  ]) if (rx.test(name)) return e;
  return null;
}

const TYPE_RULES = [
  ['etb', /elite trainer box|premium trainer box/],
  ['bb', /build\s*(&|and)\s*battle|prerelease|deck build box/],
  ['bundle', /booster bundle/],
  ['display', /booster box|booster display|display box|half booster box/],
  ['tin', /\btins?\b/],
  ['blister', /blister|checklane|\b[23]-?pack\b|three booster|3 pack/],
  ['booster', /booster pack|sleeved booster|\bbooster\b/],
  ['deck', /deck|starter set|trainer kit|start deck|battle academy|trainer's toolkit/],
  ['coll', /collection|premium|box|binder|portfolio|chest|showcase|toolkit|calendar|poster|gift|figure|set\b|classic/],
  ['booster', /\bpack\b/],
  ['coll', /bundle/],
];
const EXCLUDE = /^\w+ Energy \(|^Poke Ball$|Jumbo Card/i;

export function classify(name) {
  const n = name.toLowerCase();
  for (const [code, rx] of TYPE_RULES) if (rx.test(n)) return code;
  return 'other';
}

const GERMAN_TERMS = [
  [/Half Booster Boxe?s?\b/g, 'Display (halb)'],
  [/Pokemon Center Elite Trainer Box/g, 'Pokémon Center Elite-Trainer-Box'],
  [/Elite Trainer Box/g, 'Elite-Trainer-Box'],
  [/Booster Boxe?s?\b/g, 'Display'],
  [/Booster Bundle/g, 'Booster-Bundle'],
  [/Booster Pack/g, 'Booster'],
  [/Mini Tin/g, 'Mini-Tin'],
  [/Ultra-Premium Collection/g, 'Ultra-Premium-Kollektion'],
  [/Super-Premium Collection/g, 'Super-Premium-Kollektion'],
  [/Premium Collection/g, 'Premium-Kollektion'],
  [/Special Collection/g, 'Spezial-Kollektion'],
  [/Collection/g, 'Kollektion'],
  [/Pokemon/g, 'Pokémon'],
];

export function germanize(name, enSet, deSet) {
  let out = name;
  let keep = null;
  if (enSet && out.includes(enSet)) {
    keep = deSet || enSet;
    out = out.split(enSet).join('\u0000');
  }
  for (const [rx, rep] of GERMAN_TERMS) out = out.replace(rx, rep);
  if (keep) out = out.split('\u0000').join(keep);
  return out;
}

const serieOf = (url) => /assets\.tcgdex\.net\/[^/]+\/([^/]+)\/[^/]+/.exec(url || '')?.[1] || null;
const stripPrefix = (n) => n.replace(/^[A-Za-z0-9.\-]+:\s*/, '');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function getJson(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;
  }
}

async function readLocal(file, fallback) {
  try {
    return JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

/**
 * dump: { en: [{ g, n, a, d, p: [[pid, name, release|null]] }], jp: [...] }
 * returns the catalog object (or null when the dump is too small to be trusted)
 */
export async function buildCatalog(dump, today = new Date().toISOString().slice(0, 10)) {
  const total = dump.en.length + dump.jp.length;
  if (total < 100) return null; // something went wrong upstream – keep the bundled catalog
  const [enSets, deSets, jaSets] = await Promise.all(['en', 'de', 'ja'].map((l) => getJson(`${TCGDEX}/${l}/sets`)));
  const tpMap = await readLocal('./tcgplayer-sets.json', {});
  const deNames = await readLocal('./de-set-names.json', {});
  const enById = new Map((enSets || []).map((s) => [s.id, s]));
  const enByName = new Map((enSets || []).map((s) => [norm(s.name), s]));
  const deById = new Map((deSets || []).map((s) => [s.id, s.name]));
  const jaById = new Map((jaSets || []).map((s) => [s.id.toLowerCase(), s]));

  // product id → date estimate for groups without a usable date ("Miscellaneous" …)
  const pairs = [];
  for (const lang of ['en', 'jp'])
    for (const g of dump[lang]) {
      if (g.a === 'MCAP' || !g.d || Date.parse(today) - Date.parse(g.d) < 60 * 86400000) continue;
      for (const [pid] of g.p) pairs.push([pid, g.d]);
    }
  pairs.sort((a, b) => a[0] - b[0]);
  const pids = pairs.map((p) => p[0]);
  const dateForPid = (pid, k = 12) => {
    let lo = 0;
    let hi = pids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pids[mid] < pid) lo = mid + 1;
      else hi = mid;
    }
    const ds = pairs.slice(Math.max(0, lo - k), Math.min(pairs.length, lo + k)).map((p) => p[1]).sort();
    return ds.length ? ds[(ds.length - 1) >> 1] : '2020-01-01';
  };

  const groups = [];
  const products = [];
  for (const lang of ['en', 'jp']) {
    const jp = lang === 'jp';
    for (const g of dump[lang]) {
      const misc = g.a === 'MCAP';
      const enName = stripPrefix(g.n);
      const tset = jp ? null : enById.get(tpMap[String(g.g)]) || enByName.get(norm(enName)) || null;
      const jset = jp ? jaById.get(String(g.a || '').toLowerCase()) || null : null;
      const releases = g.p.map((p) => p[2]).filter(Boolean).sort();
      let date = g.d || releases[0] || '';
      // TCGplayer sometimes stamps old groups with a recent date – then trust the product ids
      const recent = date && Date.parse(today) - Date.parse(date) < 60 * 86400000;
      if (!misc && (!date || (recent && !releases.length && !tset && !jset))) {
        const ds = g.p.map(([pid]) => dateForPid(pid)).sort();
        const est = ds[(ds.length - 1) >> 1];
        if (!date || Date.parse(date) - Date.parse(est) > 365 * 86400000) date = est;
      }
      let era = tset ? serieOf(tset.logo) || serieOf(tset.symbol) : null;
      if (!era) era = eraByName(g.n, jp);
      if (!era && !misc) era = eraByDate(date, jp);
      const setNameEn = tset ? tset.name : enName;
      const setNameDe = (tset && deById.get(tset.id)) || deNames[setNameEn] || null;
      const display = misc ? 'Sonstige Produkte' : setNameDe || setNameEn;
      const gi = groups.length;
      groups.push([g.g, display, display !== setNameEn ? setNameEn : 0, era || 0, date, (tset || jset || {}).id || 0, lang]);
      for (const [pid, pname, release] of g.p) {
        if (EXCLUDE.test(pname)) continue;
        const pera = misc ? eraByDate(dateForPid(pid), jp) : era;
        const de = jp ? germanize(pname, setNameEn, null) : germanize(pname, setNameEn, setNameDe);
        const rel = release && release > today ? release : 0;
        products.push([pid, gi, classify(pname), pname, de !== pname ? de : 0, pera !== era ? pera : 0, rel]);
      }
    }
  }
  return { at: today, src: 'TCGplayer via tcgcsv.com', g: groups, p: products };
}
