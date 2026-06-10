const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,12}$/;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchT(url, ms) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers: HEADERS, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

/* ── Proveedor 1: Yahoo Finance ── */
async function tryYahoo(symbol) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`;
  const hosts = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
  let lastErr = "Yahoo sin respuesta";
  for (const host of hosts) {
    for (let a = 0; a < 2; a++) {
      try {
        const r = await fetchT(host + path, 8000);
        if (!r.ok) { lastErr = `Yahoo ${r.status}`; continue; }
        const j = await r.json();
        if (j && j.chart) return j;
        lastErr = "Yahoo formato inesperado";
      } catch (e) {
        lastErr = e.name === "AbortError" ? "Yahoo timeout" : (e.message || "Yahoo error");
      }
      await new Promise((x) => setTimeout(x, 250));
    }
  }
  throw new Error(lastErr);
}

/* ── Proveedor 2 (respaldo): Stooq, CSV diario ── */
function stooqSymbol(symbol) {
  const s = symbol.toLowerCase();
  if (s === "^gspc") return "^spx";
  if (s === "^ndx") return "^ndx";
  if (s === "btc-usd") return "btcusd";
  if (s === "eth-usd") return "ethusd";
  // Acciones/ETF de EE. UU.: añadir sufijo .us
  if (/^[a-z0-9.]+$/.test(s) && !s.includes(".")) return s + ".us";
  return null; // símbolo que Stooq no cubre con mapeo simple
}

async function tryStooq(symbol) {
  const ss = stooqSymbol(symbol);
  if (!ss) throw new Error("Sin respaldo para este símbolo");
  const r = await fetchT(`https://stooq.com/q/d/l/?s=${encodeURIComponent(ss)}&i=d`, 8000);
  if (!r.ok) throw new Error(`Stooq ${r.status}`);
  const csv = await r.text();
  const lines = csv.trim().split("\n");
  if (lines.length < 50 || !lines[0].toLowerCase().startsWith("date")) {
    throw new Error("Stooq sin datos");
  }
  // Tomar los últimos ~130 días y convertir al formato de Yahoo
  const rows = lines.slice(1).slice(-130);
  const timestamp = [], close = [], high = [], low = [], volume = [];
  for (const line of rows) {
    const [d, _o, h, l, c, v] = line.split(",");
    const t = Date.parse(d + "T16:00:00Z") / 1000;
    const cf = parseFloat(c), hf = parseFloat(h), lf = parseFloat(l), vf = parseFloat(v);
    if (Number.isFinite(t) && Number.isFinite(cf)) {
      timestamp.push(t);
      close.push(cf);
      high.push(Number.isFinite(hf) ? hf : cf);
      low.push(Number.isFinite(lf) ? lf : cf);
      volume.push(Number.isFinite(vf) ? vf : 0);
    }
  }
  if (close.length < 40) throw new Error("Stooq historial corto");
  return {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: close[close.length - 1],
          chartPreviousClose: close[close.length - 2],
          currency: "USD",
          shortName: symbol + " (Stooq)",
        },
        timestamp,
        indicators: { quote: [{ close, high, low, volume }] },
      }],
      error: null,
    },
  };
}

module.exports = async (req, res) => {
  const symbol = String((req.query && req.query.symbol) || "").trim();
  if (!SYMBOL_RE.test(symbol)) {
    res.status(400).json({ error: "Símbolo inválido" });
    return;
  }
  try {
    const j = await tryYahoo(symbol);
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    res.status(200).json(j);
  } catch (e1) {
    try {
      const j = await tryStooq(symbol);
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=240");
      res.status(200).json(j);
    } catch (e2) {
      res.status(502).json({ error: `${e1.message} · ${e2.message}` });
    }
  }
};
const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,12}$/;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Caché de crumb a nivel de módulo (reutilizable dentro del mismo proceso Vercel) ──
let _crumb    = null;
let _cookie   = null;
let _crumbAt  = 0;
const CRUMB_TTL = 50 * 60 * 1000; // 50 minutos

async function fetchT(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

async function getYahooCrumb() {
  if (_crumb && Date.now() - _crumbAt < CRUMB_TTL) {
    return { crumb: _crumb, cookie: _cookie };
  }
  try {
    // Paso 1: conseguir cookies de Yahoo Finance
    const r1 = await fetchT('https://finance.yahoo.com/', 8000, {
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    // getSetCookie() disponible en Node 18+ (que usa Vercel)
    const rawCookies = r1.headers.getSetCookie
      ? r1.headers.getSetCookie()
      : (r1.headers.get('set-cookie') || '').split(/,(?=[^ ])/);

    const cookie = rawCookies
      .map(c => c.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');

    // Paso 2: obtener el crumb con esas cookies
    const r2 = await fetchT(
      'https://query2.finance.yahoo.com/v1/test/getcrumb',
      8000,
      {
        headers: {
          'User-Agent': UA,
          'Cookie': cookie,
          'Accept': '*/*',
          'Referer': 'https://finance.yahoo.com/',
        },
      }
    );

    if (r2.ok) {
      const crumb = (await r2.text()).trim();
      if (crumb && crumb.length > 0 && !crumb.includes('<') && crumb !== 'Unauthorized') {
        _crumb   = crumb;
        _cookie  = cookie;
        _crumbAt = Date.now();
        console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'yahoo_crumb_ok', crumb: crumb.slice(0, 4) + '***' }));
        return { crumb: _crumb, cookie: _cookie };
      }
    }
  } catch (e) {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), msg: 'yahoo_crumb_fail', err: e.message }));
  }
  return null;
}

// ── Proveedor 1: Yahoo Finance con crumb ──
async function tryYahoo(symbol) {
  const crumbData = await getYahooCrumb();
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo` +
    (crumbData ? `&crumb=${encodeURIComponent(crumbData.crumb)}` : '');

  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://finance.yahoo.com/',
    ...(crumbData ? { 'Cookie': crumbData.cookie } : {}),
  };

  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetchT(host + path, 9000, { headers });
      if (r.status === 429) throw Object.assign(new Error('Yahoo 429'), { status: 429 });
      if (!r.ok) { console.warn(JSON.stringify({ msg: 'yahoo_err', status: r.status, symbol })); continue; }
      const j = await r.json();
      if (j?.chart) return j;
    } catch (e) {
      if (e.status === 429) throw e;
    }
  }
  throw new Error(`Yahoo sin datos para ${symbol}`);
}

// ── Proveedor 2: Stooq CSV ──
function stooqSym(sym) {
  const s = sym.toLowerCase();
  const map = { 'btc-usd': 'btcusd', 'eth-usd': 'ethusd', '^gspc': '^spx', '^ndx': '^ndx' };
  if (map[s]) return map[s];
  if (/^[a-z0-9]+$/.test(s)) return s + '.us';
  return null;
}

async function tryStooq(symbol) {
  const ss = stooqSym(symbol);
  if (!ss) throw new Error('Símbolo no soportado por Stooq');

  const now   = Math.floor(Date.now() / 1000);
  const past  = now - 200 * 86400;
  const d1    = new Date(past * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const d2    = new Date(now  * 1000).toISOString().slice(0, 10).replace(/-/g, '');

  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(ss)}&d1=${d1}&d2=${d2}&i=d`;
  const r   = await fetchT(url, 9000, {
    headers: { 'User-Agent': UA, 'Accept': 'text/csv,text/plain,*/*', 'Referer': 'https://stooq.com/' },
  });
  if (!r.ok) throw new Error(`Stooq ${r.status}`);

  const csv   = await r.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 50 || !lines[0].toLowerCase().includes('date')) {
    throw new Error('Stooq sin datos suficientes');
  }

  const rows = lines.slice(1).slice(-130);
  const ts = [], close = [], high = [], low = [], volume = [];
  for (const line of rows) {
    const [d, , h, l, c, v] = line.split(',');
    const cf = parseFloat(c), hf = parseFloat(h), lf = parseFloat(l), vf = parseFloat(v);
    const t  = Date.parse(d + 'T16:00:00Z') / 1000;
    if (isFinite(t) && isFinite(cf)) {
      ts.push(t); close.push(cf);
      high.push(isFinite(hf) ? hf : cf);
      low.push(isFinite(lf) ? lf : cf);
      volume.push(isFinite(vf) ? vf : 0);
    }
  }
  if (close.length < 40) throw new Error(`Stooq solo ${close.length} barras`);

  return {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: close[close.length - 1],
          chartPreviousClose: close[close.length - 2],
          currency: 'USD',
          shortName: symbol,
        },
        timestamp: ts,
        indicators: { quote: [{ close, high, low, volume }] },
      }],
      error: null,
    },
  };
}

// ── Handler principal ──
module.exports = async (req, res) => {
  const symbol = String((req.query && req.query.symbol) || '').trim();
  if (!SYMBOL_RE.test(symbol)) {
    return res.status(400).json({ error: 'Símbolo inválido' });
  }

  const t0 = Date.now();
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'request', symbol }));

  // Intento 1: Yahoo con crumb
  try {
    const j = await tryYahoo(symbol);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    console.log(JSON.stringify({ msg: 'yahoo_ok', symbol, ms: Date.now() - t0 }));
    return res.status(200).json(j);
  } catch (e) {
    if (e.status === 429) {
      // 429 explícito: el frontend sabe que debe usar proxy del navegador
      console.warn(JSON.stringify({ msg: 'yahoo_429', symbol, ms: Date.now() - t0 }));
      return res.status(429).json({ error: 'Yahoo rate limit — usa proxy del navegador', retryWithProxy: true });
    }
    console.warn(JSON.stringify({ msg: 'yahoo_fail', symbol, err: e.message }));
  }

  // Intento 2: Stooq
  try {
    const j = await tryStooq(symbol);
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=240');
    console.log(JSON.stringify({ msg: 'stooq_ok', symbol, ms: Date.now() - t0 }));
    return res.status(200).json(j);
  } catch (e2) {
    console.error(JSON.stringify({ msg: 'both_fail', symbol, err: e2.message, ms: Date.now() - t0 }));
    return res.status(502).json({ error: `Yahoo 429 · ${e2.message}` });
  }
};
