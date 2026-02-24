// Vercel Serverless Function — Market Data Proxy

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const { type, symbols, range } = req.query;

  const yhFetch = async (sym, r = '1y') => {
    // Try query1 first, fallback to query2
    for (const host of ['query1', 'query2']) {
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${r}`;
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Referer': 'https://finance.yahoo.com',
          },
          signal: AbortSignal.timeout(8000),
        });
        const d = await resp.json();
        const result = d?.chart?.result?.[0];
        if (!result) continue;
        return {
          sym,
          c: result.indicators.quote[0].close,
          t: result.timestamp,
        };
      } catch(e) { continue; }
    }
    return { sym, error: 'no data' };
  };

  try {
    // ── Quotes (Finnhub) ─────────────────────────────
    if (type === 'quotes') {
      const syms = (symbols || '').split(',').filter(Boolean);
      const key  = req.headers['x-fh-key'] || req.query.fhkey || '';
      const results = await Promise.allSettled(
        syms.map(s =>
          fetch(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${key}`, {
            signal: AbortSignal.timeout(6000)
          })
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

    // ── Candles (Yahoo Finance) ───────────────────────
    if (type === 'candles') {
      const syms = (symbols || '').split(',').filter(Boolean);
      const r    = range || '1y';
      const results = await Promise.allSettled(
        syms.map(sym => yhFetch(sym.replace(/__/g, '^'), r))
      );
      const data = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') data[syms[i]] = r.value;
      });
      return res.status(200).json(data);
    }

    // ── VIX (Yahoo Finance) ───────────────────────────
    if (type === 'vix') {
      const d = await yhFetch('^VIX', '5d');
      const c = (d.c || []).filter(v => v != null);
      return res.status(200).json({ vix: c.length ? +c[c.length-1].toFixed(2) : null });
    }

    // ── Breadth (NYSE via Yahoo + calculated) ─────────
    if (type === 'breadth') {
      // Fetch NYSE breadth symbols + sector ETFs for % above SMA calculation
      const breadthSyms = ['^NYMO', '^NASI', '^NYHL', '^NYA50R', '^NYA200R'];
      const sectorSyms  = ['RSPG','RSPN','RSPU','RSPH','RSPR','RSPM','RSPS','RSPC','RSPD','RSPT','RSPF'];

      const [breadthResults, sectorResults] = await Promise.all([
        Promise.allSettled(breadthSyms.map(s => yhFetch(s, '3mo'))),
        Promise.allSettled(sectorSyms.map(s => yhFetch(s, '1y'))),
      ]);

      const getLast = (results, idx) => {
        const r = results[idx];
        if (r.status !== 'fulfilled') return null;
        const c = (r.value.c || []).filter(v => v != null);
        return c.length ? c[c.length-1] : null;
      };

      const nymo  = getLast(breadthResults, 0);
      const nasi  = getLast(breadthResults, 1);
      const nyhl  = getLast(breadthResults, 2);
      const nya50 = getLast(breadthResults, 3);
      const nya200= getLast(breadthResults, 4);

      // Calculate % sectors above their 50/200 SMA as breadth proxy
      // if Yahoo NYSE breadth symbols fail
      let pct50 = nya50, pct200 = nya200;
      if (pct50 == null || pct200 == null) {
        let above50 = 0, above200 = 0, total = 0;
        sectorResults.forEach(r => {
          if (r.status !== 'fulfilled') return;
          const c = (r.value.c || []).filter(v => v != null);
          if (c.length < 200) return;
          const price = c[c.length-1];
          const s50  = c.slice(-50).reduce((a,b)=>a+b,0)/50;
          const s200 = c.slice(-200).reduce((a,b)=>a+b,0)/200;
          if (price > s50)  above50++;
          if (price > s200) above200++;
          total++;
        });
        if (total > 0) {
          if (pct50  == null) pct50  = (above50/total)*100;
          if (pct200 == null) pct200 = (above200/total)*100;
        }
      }

      return res.status(200).json({
        nymo, nasi, nyhl,
        pct50:  pct50  != null ? +pct50.toFixed(1)  : null,
        pct200: pct200 != null ? +pct200.toFixed(1) : null,
      });
    }

    return res.status(400).json({ error: 'Unknown type' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
