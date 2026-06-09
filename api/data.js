/**
 * SobriTrading · API de datos (Vercel serverless) — v2
 * Proveedor principal: Yahoo Finance (query1 + query2, con reintentos)
 * Respaldo automático: Stooq (CSV → convertido al mismo formato)
 * Uso: GET /api/data?symbol=AAPL
 */

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
