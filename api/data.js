// Vercel Serverless Function — Yahoo Finance Proxy
// Deployed automatically by Vercel, no config needed

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const { type, symbols, range } = req.query;

  try {
    if (type === 'quotes') {
      // Batch quotes via Finnhub — symbols=SPY,QQQ,IWM
      const syms = (symbols || '').split(',').filter(Boolean);
      const key  = req.headers['x-fh-key'] || req.query.fhkey || '';
      const results = await Promise.allSettled(
        syms.map(s =>
          fetch(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${key}`)
            .then(r => r.json())
            .then(d => ({ sym: s, c: d.c, pc: d.pc, o: d.o, h: d.h, l: d.l }))
        )
      );
      const data = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') data[syms[i]] = r.value;
      });
      return res.status(200).json(data);
    }

    if (type === 'candles') {
      // Batch candles from Yahoo Finance
      const syms  = (symbols || '').split(',').filter(Boolean);
      const r     = range || '1y';
      const results = await Promise.allSettled(
        syms.map(sym => {
          const yhSym = sym.replace('__', '^'); // encode ^ as __
          const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yhSym)}?interval=1d&range=${r}`;
          return fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0',
              'Accept': 'application/json',
            }
          })
          .then(r => r.json())
          .then(d => {
            const result = d?.chart?.result?.[0];
            if (!result) return { sym, error: 'no data' };
            const closes = result.indicators.quote[0].close;
            const times  = result.timestamp;
            return { sym, c: closes, t: times };
          });
        })
      );
      const data = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') data[syms[i]] = r.value;
      });
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Unknown type. Use type=quotes or type=candles' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
