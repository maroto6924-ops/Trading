/**
 * SobriTrading · /api/batch.js  v5 — Twelve Data (multi-símbolo)
 *
 * Usa el endpoint time_series de Twelve Data con MÚLTIPLES símbolos por
 * llamada (hasta 8 en plan gratuito), respetando el límite de 8 req/min.
 * Respaldo: Yahoo Finance con crumb si Twelve Data agota cuota diaria.
 */


const TWELVE_DATA_KEY = 'e95cfcd552ac41a3ac30d19620357dd0';

const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,12}$/;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchT(url, ms, opts) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal })); }
  finally { clearTimeout(tid); }
}

/* ── Mapeo símbolo → formato Twelve Data ── */
function tdSymbol(sym) {
  const map = {
    'BTC-USD':'BTC/USD','ETH-USD':'ETH/USD','SOL-USD':'SOL/USD','XRP-USD':'XRP/USD',
    '^GSPC':'SPX','^NDX':'NDX','^DJI':'DJI'
  };
  return map[sym.toUpperCase()] || sym.toUpperCase();
}
/* Mapa inverso para reconstruir resultados */
function fromTdSymbol(tdSym, original) { return original; }

/* ── Convertir una serie de Twelve Data al formato chart de Yahoo ── */
function tdToChart(values, meta, symbol) {
  if (!values || !Array.isArray(values) || values.length < 35) return null;
  const rows = values.slice().reverse(); // TD da más reciente primero
  const ts = [], close = [], high = [], low = [], volume = [];
  for (const row of rows) {
    const c = parseFloat(row.close), h = parseFloat(row.high), l = parseFloat(row.low);
    const v = parseFloat(row.volume || '0');
    const t = Date.parse(row.datetime + 'T16:00:00Z') / 1000;
    if (isFinite(t) && isFinite(c)) {
      ts.push(t); close.push(c);
      high.push(isFinite(h) ? h : c); low.push(isFinite(l) ? l : c); volume.push(isFinite(v) ? v : 0);
    }
  }
  if (close.length < 35) return null;
  const cur = (meta && meta.currency) || 'USD';
  return { chart: { result: [{ meta:{ regularMarketPrice:close[close.length-1], chartPreviousClose:close[close.length-2], currency:cur, shortName:symbol }, timestamp:ts, indicators:{ quote:[{close,high,low,volume}] } }], error:null } };
}

/* ── Twelve Data: pedir hasta 8 símbolos en UNA llamada ── */
async function fetchTwelveBatch(symbols) {
  if (!TWELVE_DATA_KEY || TWELVE_DATA_KEY === 'TU_CLAVE_AQUI') throw new Error('sin-clave');
  const tdSyms = symbols.map(tdSymbol);
  const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(tdSyms.join(',')) +
              '&interval=1day&outputsize=90&apikey=' + TWELVE_DATA_KEY;
  const r = await fetchT(url, 12000, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('TD-http-' + r.status);
  const j = await r.json();

  const out = {};
  if (symbols.length === 1) {
    // Respuesta de símbolo único: {meta, values, status}
    if (j.status === 'error') throw new Error(j.message || 'TD-error');
    const chart = tdToChart(j.values, j.meta, symbols[0]);
    if (chart) out[symbols[0]] = chart;
  } else {
    // Respuesta multi-símbolo: {"AAPL":{...}, "MSFT":{...}}
    for (let i = 0; i < symbols.length; i++) {
      const td = tdSyms[i], orig = symbols[i];
      const entry = j[td];
      if (entry && entry.status !== 'error' && entry.values) {
        const chart = tdToChart(entry.values, entry.meta, orig);
        if (chart) out[orig] = chart;
      }
    }
  }
  return { out, raw: j };
}

/* ── Respaldo Yahoo ── */
let _crumb = null, _cookie = null, _crumbAt = 0;
const CRUMB_TTL = 40 * 60 * 1000;
async function getCrumb() {
  if (_crumb && (Date.now() - _crumbAt) < CRUMB_TTL) return { crumb: _crumb, cookie: _cookie };
  for (const seed of ['https://fc.yahoo.com/', 'https://finance.yahoo.com/']) {
    try {
      const r1 = await fetchT(seed, 6000, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' } });
      const raw = r1.headers.getSetCookie ? r1.headers.getSetCookie() : (r1.headers.get('set-cookie') || '').split(',').filter(s => s.trim());
      const cookie = raw.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
      if (!cookie) continue;
      const r2 = await fetchT('https://query2.finance.yahoo.com/v1/test/getcrumb', 6000, { headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': '*/*', 'Referer': 'https://finance.yahoo.com/' } });
      if (r2.ok) { const crumb = (await r2.text()).trim(); if (crumb && !crumb.includes('<') && crumb !== 'Unauthorized') { _crumb = crumb; _cookie = cookie; _crumbAt = Date.now(); return { crumb, cookie }; } }
    } catch (_) {}
  }
  return null;
}
async function fromYahoo(symbol, cd) {
  const qs = '?interval=1d&range=3mo' + (cd ? ('&crumb=' + encodeURIComponent(cd.crumb)) : '');
  const path = '/v8/finance/chart/' + encodeURIComponent(symbol) + qs;
  const headers = Object.assign({ 'User-Agent': UA, 'Accept': 'application/json,*/*', 'Referer': 'https://finance.yahoo.com/' }, cd ? { 'Cookie': cd.cookie } : {});
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try { const r = await fetchT(host + path, 7000, { headers }); if (!r.ok) continue; const j = await r.json(); if (j?.chart?.result) return j; } catch (_) {}
  }
  throw new Error('Y-fail');
}

module.exports = async function(req, res) {
  const raw = String((req.query && req.query.symbols) || '');
  const symbols = raw.split(',').map(s => s.trim()).filter(s => SYMBOL_RE.test(s)).slice(0, 16);
  if (!symbols.length) return res.status(400).json({ error: 'Sin símbolos válidos' });

  const t0 = Date.now();
  const results = {}, errors = {};
  let tdNote = '';

  // ── Twelve Data: lotes de 8 símbolos por llamada (plan gratuito) ──
  // Con el universo de 8, normalmente es UNA sola llamada → instantáneo.
  const TD_BATCH = 8;
  for (let i = 0; i < symbols.length; i += TD_BATCH) {
    const chunk = symbols.slice(i, i + TD_BATCH);
    try {
      const { out } = await fetchTwelveBatch(chunk);
      Object.assign(results, out);
    } catch (e) { tdNote = e.message; }
    if (i + TD_BATCH < symbols.length) await sleep(7500); // respetar 8 req/min si hay >8
  }

  // ── Yahoo como respaldo para lo que falte ──
  const missing = symbols.filter(s => !results[s]);
  if (missing.length) {
    const cd = await getCrumb();
    const settled = await Promise.allSettled(missing.map(s => fromYahoo(s, cd)));
    settled.forEach((r, j) => {
      const sym = missing[j];
      if (r.status === 'fulfilled') results[sym] = r.value;
      else errors[sym] = 'Sin datos en ninguna fuente';
    });
  }

  console.log(JSON.stringify({ msg:'batch', n:symbols.length, ok:Object.keys(results).length, td:tdNote, ms:Date.now()-t0 }));
  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=120');
  res.status(200).json({ results, errors, ms: Date.now() - t0, _diag: { okCount: Object.keys(results).length, total: symbols.length, tdNote } });
};
