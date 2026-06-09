
/**
 * SobriTrading · API de datos de mercado (función serverless de Vercel)
 *
 * Pide los datos a Yahoo Finance DESDE EL SERVIDOR de Vercel, con cabeceras
 * de navegador real. Al ser el mismo dominio que la web, no hay CORS ni
 * proxies gratuitos: se acabaron los "Load failed" y los HTTP 400/403.
 *
 * Uso:  GET /api/data?symbol=AAPL
 * Caché: 60s en el edge de Vercel (reduce carga y acelera el scanner).
 */

const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,12}$/;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers: HEADERS, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

module.exports = async (req, res) => {
  const symbol = String(req.query.symbol || "").trim();

  if (!SYMBOL_RE.test(symbol)) {
    res.status(400).json({ error: "Símbolo inválido" });
    return;
  }

  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`;
  const hosts = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

  let lastErr = "Sin respuesta del proveedor";
  for (const host of hosts) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchWithTimeout(host + path, 8000);
        if (r.status === 429) { lastErr = "Límite de peticiones del proveedor"; continue; }
        if (!r.ok) { lastErr = `Proveedor respondió ${r.status}`; continue; }
        const json = await r.json();
        if (json && json.chart) {
          // Caché compartida en el edge de Vercel: 60s fresca + 2 min de gracia
          res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
          res.status(200).json(json);
          return;
        }
        lastErr = "Formato inesperado";
      } catch (e) {
        lastErr = e.name === "AbortError" ? "Tiempo agotado" : (e.message || "Error de red");
      }
      await new Promise((r2) => setTimeout(r2, 300));
    }
  }

  res.status(502).json({ error: lastErr });
};
