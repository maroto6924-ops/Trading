/**
 * SobriTrading · /api/batch.js  v7
 *
 * Twelve Data (plan gratuito = 8 req/min) con CACHÉ EN SERVIDOR de 10 min.
 * Los datos diarios solo cambian una vez al día, así que cachear 10 min
 * elimina el problema del límite 429 por completo: aunque la app reescanee
 * cada 2 minutos, las llamadas reales a Twelve Data son mínimas.
 *
 * Cola de peticiones: máximo 7 llamadas/min reales (margen bajo el límite de 8).
 */

const TWELVE_DATA_KEY = 'e95cfcd552ac41a3ac30d19620357dd0';

const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,12}$/;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Caché en memoria del servidor (persiste en instancias calientes) ── */
const CACHE = new Map();           // symbol → { chart, at }
const CACHE_TTL = 4 * 60 * 1000;   // 4 min (intradía: datos de 5min se refrescan rápido)

/* ── Control de tasa: registro de timestamps de llamadas a Twelve Data ── */
let _tdCalls = [];                  // timestamps de las últimas llamadas
function canCallTD() {
  const now = Date.now();
  _tdCalls = _tdCalls.filter(t => now - t < 60000); // solo último minuto
  return _tdCalls.length < 7;        // margen: 7 de 8 permitidas
}
function recordTD() { _tdCalls.push(Date.now()); }

async function fetchT(url, ms, opts) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal })); }
  finally { clearTimeout(tid); }
}

function tdSymbol(sym) {
  const map = { 'BTC-USD':'BTC/USD','ETH-USD':'ETH/USD','SOL-USD':'SOL/USD','XRP-USD':'XRP/USD','^GSPC':'SPX','^NDX':'NDX','^DJI':'DJI' };
  return map[sym.toUpperCase()] || sym.toUpperCase();
}

function tdToChart(values, meta, symbol) {
  if (!values || !Array.isArray(values) || values.length < 35) return null;
  const rows = values.slice().reverse();
  const ts=[], close=[], high=[], low=[], volume=[];
  for (const row of rows) {
    const c=parseFloat(row.close), h=parseFloat(row.high), l=parseFloat(row.low), v=parseFloat(row.volume||'0');
    const t=Date.parse((row.datetime.length>10 ? row.datetime.replace(' ','T')+'Z' : row.datetime+'T16:00:00Z'))/1000;
    if (isFinite(t) && isFinite(c)) { ts.push(t); close.push(c); high.push(isFinite(h)?h:c); low.push(isFinite(l)?l:c); volume.push(isFinite(v)?v:0); }
  }
  if (close.length < 35) return null;
  return { chart:{ result:[{ meta:{ regularMarketPrice:close[close.length-1], chartPreviousClose:close[close.length-2], currency:(meta&&meta.currency)||'USD', shortName:symbol }, timestamp:ts, indicators:{ quote:[{close,high,low,volume}] } }], error:null } };
}

async function fromTwelveData(symbol, interval) {
  const iv = interval || '5min';
  // Intradía: 5min → 100 barras (~1.3 sesiones). Diario: 90 barras.
  const outputsize = iv === '1day' ? 90 : 100;
  const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(tdSymbol(symbol)) +
              '&interval=' + iv + '&outputsize=' + outputsize + '&apikey=' + TWELVE_DATA_KEY;
  recordTD();
  const r = await fetchT(url, 9000, { headers: { 'User-Agent': UA } });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error('TD-noJSON'); }
  if (j.status === 'error' || (j.code && j.code >= 400)) throw new Error('TD:' + (j.message || j.code || 'error').toString().slice(0, 50));
  if (!j.values) throw new Error('TD-sin-values');
  const chart = tdToChart(j.values, j.meta, symbol);
  if (!chart) throw new Error('TD-pocos-datos');
  return chart;
}

/* Respaldo Yahoo */
let _crumb=null,_cookie=null,_crumbAt=0;
const CRUMB_TTL=40*60*1000;
async function getCrumb(){
  if(_crumb&&(Date.now()-_crumbAt)<CRUMB_TTL)return{crumb:_crumb,cookie:_cookie};
  for(const seed of['https://fc.yahoo.com/','https://finance.yahoo.com/']){
    try{
      const r1=await fetchT(seed,6000,{redirect:'follow',headers:{'User-Agent':UA,'Accept':'text/html,*/*'}});
      const raw=r1.headers.getSetCookie?r1.headers.getSetCookie():(r1.headers.get('set-cookie')||'').split(',').filter(s=>s.trim());
      const cookie=raw.map(c=>c.split(';')[0].trim()).filter(Boolean).join('; ');
      if(!cookie)continue;
      const r2=await fetchT('https://query2.finance.yahoo.com/v1/test/getcrumb',6000,{headers:{'User-Agent':UA,'Cookie':cookie,'Accept':'*/*','Referer':'https://finance.yahoo.com/'}});
      if(r2.ok){const crumb=(await r2.text()).trim();if(crumb&&!crumb.includes('<')&&crumb!=='Unauthorized'){_crumb=crumb;_cookie=cookie;_crumbAt=Date.now();return{crumb,cookie};}}
    }catch(_){}
  }
  return null;
}
async function fromYahoo(symbol,cd,interval){
  const iv = (interval==='5min')?'5m':(interval==='15min')?'15m':'1d';
  const range = (iv==='1d')?'3mo':'5d';
  const qs='?interval='+iv+'&range='+range+(cd?('&crumb='+encodeURIComponent(cd.crumb)):'');
  const path='/v8/finance/chart/'+encodeURIComponent(symbol)+qs;
  const headers=Object.assign({'User-Agent':UA,'Accept':'application/json,*/*','Referer':'https://finance.yahoo.com/'},cd?{'Cookie':cd.cookie}:{});
  for(const host of['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']){
    try{const r=await fetchT(host+path,7000,{headers});if(!r.ok)continue;const j=await r.json();if(j?.chart?.result)return j;}catch(_){}
  }
  throw new Error('Y-fail');
}

/* Obtener un símbolo: caché → Twelve Data (si hay cuota) → Yahoo */
async function getSymbol(symbol, cd, interval) {
  // Caché por símbolo+intervalo (intradía y diario son distintos)
  const ckey = symbol + ':' + (interval || '5min');
  const cached = CACHE.get(ckey);
  if (cached && (Date.now() - cached.at) < CACHE_TTL) return { chart: cached.chart, src: 'cache' };

  // Twelve Data si queda cuota este minuto
  if (canCallTD()) {
    try {
      const chart = await fromTwelveData(symbol, interval);
      CACHE.set(ckey, { chart, at: Date.now() });
      return { chart, src: 'td' };
    } catch (e) { /* sigue a Yahoo */ }
  }

  // Yahoo (solo soporta intradía limitado; usar como respaldo de diario)
  try {
    const chart = await fromYahoo(symbol, cd, interval);
    CACHE.set(ckey, { chart, at: Date.now() });
    return { chart, src: 'yahoo' };
  } catch (e) { /* nada */ }

  // Caché vieja como último recurso
  if (cached) return { chart: cached.chart, src: 'cache-old' };

  throw new Error('Sin datos');
}

module.exports = async function(req, res) {
  const raw = String((req.query && req.query.symbols) || '');
  const symbols = raw.split(',').map(s => s.trim()).filter(s => SYMBOL_RE.test(s)).slice(0, 32);
  if (!symbols.length) return res.status(400).json({ error: 'Sin símbolos válidos' });
  // Intervalo: 5min (intradía, por defecto) o 1day. Validar.
  const interval = ['5min','15min','1day'].includes(String(req.query.interval)) ? String(req.query.interval) : '5min';

  const t0 = Date.now();
  const TIME_BUDGET = 8000; // 8s máx (Vercel Hobby corta a 10s)
  const results = {}, errors = {};
  const srcCount = { cache: 0, td: 0, yahoo: 0, 'cache-old': 0 };

  // PASO 1: servir TODO lo que ya está en caché al instante (no gasta tiempo de red)
  const needFetch = [];
  for (const sym of symbols) {
    const ckey = sym + ':' + interval;
    const cached = CACHE.get(ckey);
    if (cached && (Date.now() - cached.at) < CACHE_TTL) {
      results[sym] = cached.chart; srcCount.cache++;
    } else {
      needFetch.push(sym);
    }
  }

  // PASO 2: con el tiempo restante, ir a buscar los que faltan (TD/Yahoo)
  let pending = [];
  if (needFetch.length) {
    const cd = await getCrumb().catch(() => null);
    const CHUNK = 4;
    for (let i = 0; i < needFetch.length; i += CHUNK) {
      if (Date.now() - t0 > TIME_BUDGET) { pending = needFetch.slice(i); break; }
      const chunk = needFetch.slice(i, i + CHUNK);
      const settled = await Promise.allSettled(chunk.map(s => getSymbol(s, cd, interval)));
      settled.forEach((r, j) => {
        const sym = chunk[j];
        if (r.status === 'fulfilled') { results[sym] = r.value.chart; srcCount[r.value.src]++; }
        else errors[sym] = r.reason?.message || 'Error';
      });
      if (i + CHUNK < needFetch.length) await sleep(150);
    }
  }
  // Los pendientes (sin tiempo) no son error: se cargarán en la siguiente llamada
  pending.forEach(s => { if (!errors[s]) errors[s] = 'pendiente'; });

  const diag = { version: 'v9-intraday', interval, okCount: Object.keys(results).length, total: symbols.length, pending: pending.length, sources: srcCount, ms: Date.now() - t0 };
  console.log(JSON.stringify({ msg: 'batch', ...diag }));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ results, errors, _diag: diag });
};
