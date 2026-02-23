// Vercel Serverless Function — Market Data Proxy
// Yahoo Finance for candles + VIX, Finnhub for quotes

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const { type, symbols, range } = req.query;

  const yhFetch = async (sym, r='1y') => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${r}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    const d = await res.json();
    const result = d?.chart?.result?.[0];
    if (!result) return { sym, error: 'no data' };
    return { sym, c: result.indicators.quote[0].close, t: result.timestamp };
  };

  try {
    if (type === 'quotes') {
      // Batch Finnhub quotes
      const syms = (symbols || '').split(',').filter(Boolean);
      const key  = req.headers['x-fh-key'] || req.query.fhkey || '';
      const results = await Promise.allSettled(
        syms.map(s =>
          fetch(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${key}`)
            .then(r => r.json())
            .then(d => ({ sym: s, c: d.c, pc: d.pc }))
        )
      );
      const data = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') data[syms[i]] = r.value;
      });
      return res.status(200).json(data);
    }

    if (type === 'candles') {
      // Batch Yahoo Finance candles (^ encoded as __ in URL)
      const syms = (symbols || '').split(',').filter(Boolean);
      const r    = range || '1y';
      const results = await Promise.allSettled(
        syms.map(sym => yhFetch(sym.replace('__', '^'), r))
      );
      const data = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') data[syms[i]] = r.value;
      });
      return res.status(200).json(data);
    }

    if (type === 'vix') {
      // VIX via Yahoo Finance (Finnhub Free Tier doesn't support it)
      const d = await yhFetch('^VIX', '5d');
      const c = (d.c || []).filter(v => v != null);
      return res.status(200).json({ vix: c.length ? c[c.length-1] : null });
    }

    return res.status(400).json({ error: 'Unknown type' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
