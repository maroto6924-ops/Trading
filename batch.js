/**
 * SobriTrading · /api/batch.js
 *
 * UN SOLO endpoint que recibe todos los símbolos a la vez,
 * obtiene el crumb de Yahoo UNA VEZ, y los descarga en secuencia
 * con pequeño delay. Así Vercel no dispara 15 peticiones
 * paralelas que Yahoo bloqueaba con 429.
 *
 * GET /api/batch?symbols=AAPL,MSFT,NVDA,...
 * → { results: { AAPL: {...chartData}, ... }, errors: { NVDA: "msg" } }
 */

const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,12}$/;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── Crumb cacheado en módulo (reutilizable en instancias calientes) ── */
let _crumb = null, _cookie = null, _crumbAt = 0;
const CRUMB_TTL = 40 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchT(url, ms, opts) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal }));
  } finally {
    clearTimeout(tid);
  }
}

async function getYahooCrumb() {
  if (_crumb && (Date.now() - _crumbAt) < CRUMB_TTL) return { crumb: _crumb, cookie: _cookie };
  try {
    const r1 = await fetchT('https://finance.yahoo.com/', 7000, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.5' }
    });
    let rawCookies = [];
    if (r1.headers.getSetCookie) {
      rawCookies = r1.headers.getSetCookie();
    } else {
      rawCookies = (r1.headers.get('set-cookie') || '').split(',').filter(s => s.trim());
    }
    const cookie = rawCookies.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
    const r2 = await fetchT('https://query2.finance.yahoo.com/v1/test/getcrumb', 6000, {
      headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': '*/*', 'Referer': 'https://finance.yahoo.com/' }
    });
    if (r2.ok) {
      const crumb = (await r2.text()).trim();
      if (crumb && crumb.length > 0 && !crumb.includes('<') && crumb !== 'Unauthorized') {
        _crumb = crumb; _cookie = cookie; _crumbAt = Date.now();
        return { crumb: _crumb, cookie: _cookie };
      }
    }
  } catch (_) {}
  return null;
}

async function fetchYahooSym(symbol, crumbData) {
  const qs = '?interval=1d&range=3mo' + (crumbData ? ('&crumb=' + encodeURIComponent(crumbData.crumb)) : '');
  const path = '/v8/finance/chart/' + encodeURIComponent(symbol) + qs;
  const headers = Object.assign(
    { 'User-Agent': UA, 'Accept': 'application/json,*/*', 'Referer': 'https://finance.yahoo.com/' },
    crumbData ? { 'Cookie': crumbData.cookie } : {}
  );
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetchT(host + path, 8000, { headers });
      if (r.status === 429) { const e = new Error('Yahoo 429'); e.status = 429; throw e; }
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.chart) return j;
    } catch (e) { if (e.status === 429) throw e; }
  }
  throw new Error('Yahoo sin datos');
}

const STOOQ_MAP = {
  'btc-usd':'btcusd','eth-usd':'ethusd','^gspc':'^spx','^ndx':'^ndx',
  'spy':'spy.us','qqq':'qqq.us','gld':'gld.us','slv':'slv.us',
  'xom':'xom.us','lly':'lly.us','jpm':'jpm.us','v':'v.us',
  'aapl':'aapl.us','msft':'msft.us','nvda':'nvda.us','googl':'googl.us',
  'meta':'meta.us','amzn':'amzn.us','tsla':'tsla.us',
  'nflx':'nflx.us','uber':'uber.us','pypl':'pypl.us','baba':'baba.us'
};

function stooqSym(s) {
  const k = s.toLowerCase();
  return STOOQ_MAP[k] || (/^[a-z0-9]+$/.test(k) ? k + '.us' : null);
}

async function fetchStooqSym(symbol) {
  const ss = stooqSym(symbol);
  if (!ss) throw new Error('Símbolo no soportado en Stooq');
  const now = Date.now();
  const d1 = new Date(now - 130 * 86400 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const d2 = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(ss) + '&d1=' + d1 + '&d2=' + d2 + '&i=d';
  const r = await fetchT(url, 9000, {
    headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*', 'Referer': 'https://stooq.com/' }
  });
  if (!r.ok) throw new Error('Stooq ' + r.status);
  const csv = await r.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 35 || !lines[0].toLowerCase().includes('date')) throw new Error('Stooq sin datos');
  const ts = [], close = [], high = [], low = [], volume = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    const d = p[0], h = parseFloat(p[2]), l = parseFloat(p[3]), c = parseFloat(p[4]), v = parseFloat(p[5]);
    const t = Date.parse(d + 'T16:00:00Z') / 1000;
    if (isFinite(t) && isFinite(c)) {
      ts.push(t); close.push(c);
      high.push(isFinite(h) ? h : c); low.push(isFinite(l) ? l : c); volume.push(isFinite(v) ? v : 0);
    }
  }
  if (close.length < 35) throw new Error('Stooq solo ' + close.length + ' barras');
  return {
    chart: { result: [{ meta: { regularMarketPrice: close[close.length-1], chartPreviousClose: close[close.length-2], currency: 'USD', shortName: symbol }, timestamp: ts, indicators: { quote: [{ close, high, low, volume }] } }], error: null }
  };
}

module.exports = async function(req, res) {
  const raw = String((req.query && req.query.symbols) || '');
  const symbols = raw.split(',').map(s => s.trim()).filter(s => SYMBOL_RE.test(s)).slice(0, 15);
  if (!symbols.length) return res.status(400).json({ error: 'Sin símbolos válidos' });

  const t0 = Date.now();
  const results = {}, errors = {};

  /* ── 1. Obtener crumb Yahoo UNA SOLA VEZ para toda la sesión ── */
  const crumbData = await getYahooCrumb();

  /* ── 2. Descargar cada símbolo en SECUENCIA (no en paralelo) ── */
  for (const sym of symbols) {
    /* a) Intentar Yahoo con crumb */
    let ok = false;
    try {
      results[sym] = await fetchYahooSym(sym, crumbData);
      ok = true;
    } catch (yErr) {
      /* b) Si Yahoo falla (429 u otro), intentar Stooq */
      try {
        results[sym] = await fetchStooqSym(sym);
        ok = true;
      } catch (sErr) {
        errors[sym] = yErr.message + ' · ' + sErr.message;
      }
    }

    /* Pequeño delay entre peticiones para no saturar Yahoo */
    if (ok) await sleep(80);
    else await sleep(40);
  }

  const elapsed = Date.now() - t0;
  console.log(JSON.stringify({ msg:'batch_done', symbols:symbols.length, ok:Object.keys(results).length, err:Object.keys(errors).length, ms:elapsed }));

  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=120');
  res.status(200).json({ results, errors, ms: elapsed });
};

