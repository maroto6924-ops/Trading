/**
 * SobriTrading · api/data.js  v5
 * - Rango 3mo (suficiente para las 8 estrategias, menos bloqueos)
 * - Yahoo Finance con crumb + cookies cacheados en módulo
 * - Stooq con mapeo explícito de símbolos
 * - 429 explícito → frontend usa proxies del navegador
 */

const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,12}$/;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let _crumb = null, _cookie = null, _crumbAt = 0;
const CRUMB_TTL = 45 * 60 * 1000;

async function fetchT(url, ms, opts) {
  opts = opts || {};
  const ctrl = new AbortController();
  const tid = setTimeout(function() { ctrl.abort(); }, ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
  finally { clearTimeout(tid); }
}

async function getYahooCrumb() {
  if (_crumb && (Date.now() - _crumbAt) < CRUMB_TTL) return { crumb: _crumb, cookie: _cookie };
  try {
    const r1 = await fetchT('https://finance.yahoo.com/', 8000, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.5' }
    });
    let rawCookies = [];
    if (r1.headers.getSetCookie) {
      rawCookies = r1.headers.getSetCookie();
    } else {
      const hdr = r1.headers.get('set-cookie') || '';
      rawCookies = hdr.split(',').filter(function(s) { return s.trim().length > 0; });
    }
    const cookie = rawCookies.map(function(c) { return c.split(';')[0].trim(); }).filter(Boolean).join('; ');
    const r2 = await fetchT('https://query2.finance.yahoo.com/v1/test/getcrumb', 7000, {
      headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': '*/*', 'Referer': 'https://finance.yahoo.com/' }
    });
    if (r2.ok) {
      const crumb = (await r2.text()).trim();
      if (crumb && crumb.length > 0 && crumb.indexOf('<') === -1 && crumb !== 'Unauthorized') {
        _crumb = crumb; _cookie = cookie; _crumbAt = Date.now();
        return { crumb: _crumb, cookie: _cookie };
      }
    }
  } catch (_) {}
  return null;
}

async function tryYahoo(symbol) {
  const cd = await getYahooCrumb();
  const qs = '?interval=1d&range=3mo' + (cd ? ('&crumb=' + encodeURIComponent(cd.crumb)) : '');
  const path = '/v8/finance/chart/' + encodeURIComponent(symbol) + qs;
  const headers = Object.assign(
    { 'User-Agent': UA, 'Accept': 'application/json,*/*', 'Accept-Language': 'en-US,en;q=0.5', 'Referer': 'https://finance.yahoo.com/' },
    cd ? { 'Cookie': cd.cookie } : {}
  );
  const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  for (let i = 0; i < hosts.length; i++) {
    try {
      const r = await fetchT(hosts[i] + path, 9000, { headers: headers });
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
  'meta':'meta.us','amzn':'amzn.us','tsla':'tsla.us','nflx':'nflx.us',
  'uber':'uber.us','pypl':'pypl.us','baba':'baba.us'
};

function stooqSym(s) {
  const k = s.toLowerCase();
  if (STOOQ_MAP[k]) return STOOQ_MAP[k];
  if (/^[a-z0-9]+$/.test(k)) return k + '.us';
  return null;
}

async function tryStooq(symbol) {
  const ss = stooqSym(symbol);
  if (!ss) throw new Error('Símbolo no soportado por Stooq');
  const now = Date.now();
  const d1 = new Date(now - 130 * 86400 * 1000).toISOString().slice(0,10).replace(/-/g,'');
  const d2 = new Date(now).toISOString().slice(0,10).replace(/-/g,'');
  const url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(ss) + '&d1=' + d1 + '&d2=' + d2 + '&i=d';
  const r = await fetchT(url, 10000, {
    headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*', 'Referer': 'https://stooq.com/' }
  });
  if (!r.ok) throw new Error('Stooq ' + r.status);
  const csv = await r.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 35 || lines[0].toLowerCase().indexOf('date') === -1) throw new Error('Stooq sin datos');
  const ts=[], close=[], high=[], low=[], volume=[];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const d=parts[0], h=parseFloat(parts[2]), l=parseFloat(parts[3]), c=parseFloat(parts[4]), v=parseFloat(parts[5]);
    const t = Date.parse(d + 'T16:00:00Z') / 1000;
    if (isFinite(t) && isFinite(c)) {
      ts.push(t); close.push(c);
      high.push(isFinite(h)?h:c); low.push(isFinite(l)?l:c); volume.push(isFinite(v)?v:0);
    }
  }
  if (close.length < 35) throw new Error('Stooq solo ' + close.length + ' barras');
  return {
    chart: { result: [{ meta: { regularMarketPrice:close[close.length-1], chartPreviousClose:close[close.length-2], currency:'USD', shortName:symbol },
      timestamp:ts, indicators:{ quote:[{ close:close, high:high, low:low, volume:volume }] } }], error:null }
  };
}

module.exports = async function(req, res) {
  const symbol = String((req.query && req.query.symbol) || '').trim();
  if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: 'Símbolo inválido' });
  try {
    const j = await tryYahoo(symbol);
    res.setHeader('Cache-Control', 's-maxage=60,stale-while-revalidate=120');
    return res.status(200).json(j);
  } catch (e) {
    if (e.status === 429) return res.status(429).json({ error: 'Yahoo rate limit', retryWithProxy: true });
  }
  try {
    const j = await tryStooq(symbol);
    res.setHeader('Cache-Control', 's-maxage=120,stale-while-revalidate=240');
    return res.status(200).json(j);
  } catch (e2) {
    return res.status(502).json({ error: 'Yahoo bloqueado · ' + e2.message });
  }
};
