
const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,12}$/;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let _crumb = null, _cookie = null, _crumbAt = 0;
const CRUMB_TTL = 40 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchT(url, ms, opts) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal })); }
  finally { clearTimeout(tid); }
}

/* ── Crumb + cookies de Yahoo (cacheado en módulo) ── */
async function getCrumb() {
  if (_crumb && (Date.now() - _crumbAt) < CRUMB_TTL) return { crumb: _crumb, cookie: _cookie };
  try {
    const r1 = await fetchT('https://fc.yahoo.com/', 6000, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' }
    }).catch(() => null);

    let cookie = '';
    if (r1) {
      const raw = r1.headers.getSetCookie ? r1.headers.getSetCookie()
        : (r1.headers.get('set-cookie') || '').split(',').filter(s => s.trim());
      cookie = raw.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
    }

    // Fallback de cookies vía finance.yahoo.com si fc.yahoo.com no dio
    if (!cookie) {
      const r1b = await fetchT('https://finance.yahoo.com/', 6000, {
        redirect: 'follow', headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' }
      }).catch(() => null);
      if (r1b) {
        const raw = r1b.headers.getSetCookie ? r1b.headers.getSetCookie()
          : (r1b.headers.get('set-cookie') || '').split(',').filter(s => s.trim());
        cookie = raw.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
      }
    }

    const r2 = await fetchT('https://query2.finance.yahoo.com/v1/test/getcrumb', 6000, {
      headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': '*/*', 'Referer': 'https://finance.yahoo.com/' }
    });
    if (r2.ok) {
      const crumb = (await r2.text()).trim();
      if (crumb && crumb.length > 0 && !crumb.includes('<') && crumb !== 'Unauthorized') {
        _crumb = crumb; _cookie = cookie; _crumbAt = Date.now();
        return { crumb, cookie };
      }
    }
  } catch (_) {}
  return null;
}

/* ── Fuente 1+2: Yahoo Finance ── */
async function fromYahoo(symbol, cd) {
  const qs = '?interval=1d&range=3mo' + (cd ? ('&crumb=' + encodeURIComponent(cd.crumb)) : '');
  const path = '/v8/finance/chart/' + encodeURIComponent(symbol) + qs;
  const headers = Object.assign(
    { 'User-Agent': UA, 'Accept': 'application/json,*/*', 'Referer': 'https://finance.yahoo.com/' },
    cd ? { 'Cookie': cd.cookie } : {}
  );
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetchT(host + path, 7000, { headers });
      if (r.status === 429) { const e = new Error('429'); e.is429 = true; throw e; }
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.chart?.result) return j;
    } catch (e) { if (e.is429) throw e; }
  }
  throw new Error('Yahoo sin datos');
}

/* ── Fuente 3: Stooq CSV ── */
const STOOQ_MAP = {
  'btc-usd':'btcusd','eth-usd':'ethusd','sol-usd':'solusd','xrp-usd':'xrpusd',
  '^gspc':'^spx','^ndx':'^ndx','^dji':'^dji','^ftse':'^ftm',
  'spy':'spy.us','qqq':'qqq.us','gld':'gld.us','slv':'slv.us','dia':'dia.us',
  'xom':'xom.us','lly':'lly.us','jpm':'jpm.us','v':'v.us','ma':'ma.us',
  'aapl':'aapl.us','msft':'msft.us','nvda':'nvda.us','googl':'googl.us',
  'meta':'meta.us','amzn':'amzn.us','tsla':'tsla.us','nflx':'nflx.us',
  'uber':'uber.us','pypl':'pypl.us','baba':'baba.us','dis':'dis.us','ko':'ko.us'
};
function stooqSym(s) {
  const k = s.toLowerCase();
  return STOOQ_MAP[k] || (/^[a-z0-9]+$/.test(k) ? k + '.us' : null);
}
async function fromStooq(symbol) {
  const ss = stooqSym(symbol);
  if (!ss) throw new Error('no-stooq');
  const now = Date.now();
  const d1 = new Date(now - 130 * 86400 * 1000).toISOString().slice(0,10).replace(/-/g,'');
  const d2 = new Date(now).toISOString().slice(0,10).replace(/-/g,'');
  const url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(ss) + '&d1=' + d1 + '&d2=' + d2 + '&i=d';
  const r = await fetchT(url, 8000, { headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*', 'Referer': 'https://stooq.com/' } });
  if (!r.ok) throw new Error('Stooq ' + r.status);
  const csv = await r.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 35 || !lines[0].toLowerCase().includes('date')) throw new Error('Stooq vacío');
  const ts=[], close=[], high=[], low=[], volume=[];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    const h=parseFloat(p[2]), l=parseFloat(p[3]), c=parseFloat(p[4]), v=parseFloat(p[5]);
    const t = Date.parse(p[0] + 'T16:00:00Z') / 1000;
    if (isFinite(t) && isFinite(c)) { ts.push(t); close.push(c); high.push(isFinite(h)?h:c); low.push(isFinite(l)?l:c); volume.push(isFinite(v)?v:0); }
  }
  if (close.length < 35) throw new Error('Stooq corto');
  return { chart: { result: [{ meta:{ regularMarketPrice:close[close.length-1], chartPreviousClose:close[close.length-2], currency:'USD', shortName:symbol }, timestamp:ts, indicators:{ quote:[{close,high,low,volume}] } }], error:null } };
}

/* ── Una sola función que prueba las 3 fuentes ── */
async function fetchOne(symbol, cd) {
  try { return await fromYahoo(symbol, cd); }
  catch (e1) {
    try { return await fromStooq(symbol); }
    catch (e2) {
      const m1 = e1.is429 ? 'Yahoo 429' : e1.message;
      throw new Error(m1 + ' · ' + e2.message);
    }
  }
}

module.exports = async function(req, res) {
  const raw = String((req.query && req.query.symbols) || '');
  const symbols = raw.split(',').map(s => s.trim()).filter(s => SYMBOL_RE.test(s)).slice(0, 16);
  if (!symbols.length) return res.status(400).json({ error: 'Sin símbolos válidos' });

  const t0 = Date.now();
  const results = {}, errors = {};
  const cd = await getCrumb();

  // Procesar en mini-lotes de 3 en paralelo: equilibrio entre velocidad
  // (caber en el límite de 10s de Vercel Hobby) y no saturar Yahoo.
  const CHUNK = 3;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const settled = await Promise.allSettled(chunk.map(s => fetchOne(s, cd)));
    settled.forEach((r, j) => {
      const sym = chunk[j];
      if (r.status === 'fulfilled') results[sym] = r.value;
      else errors[sym] = r.reason?.message || 'Error';
    });
    if (i + CHUNK < symbols.length) await sleep(120);
  }

  console.log(JSON.stringify({ msg:'batch', n:symbols.length, ok:Object.keys(results).length, err:Object.keys(errors).length, ms:Date.now()-t0 }));
  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=120');
  res.status(200).json({ results, errors, ms: Date.now() - t0 });
};

