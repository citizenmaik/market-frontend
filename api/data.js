// Vercel Serverless Function — Market Data Proxy
// Yahoo Finance for candles, Finnhub for quotes
// McClellan calculated from NYSE Advance/Decline data

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const { type, symbols, range } = req.query;

  // ── Yahoo Finance fetch helper ──────────────────────
  const yhFetch = async (sym, r = '1y') => {
    for (const host of ['query1', 'query2']) {
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${r}`;
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://finance.yahoo.com',
            'Origin': 'https://finance.yahoo.com',
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

  // ── Math helpers ────────────────────────────────────
  const cleanArr = arr => (arr || []).map((v, i) => ({ v, i })).filter(x => x.v != null && !isNaN(x.v));

  const ema = (values, period) => {
    const k = 2 / (period + 1);
    let e = values[0];
    const result = [e];
    for (let i = 1; i < values.length; i++) {
      e = values[i] * k + e * (1 - k);
      result.push(e);
    }
    return result;
  };

  try {
    // ── Quotes (Finnhub) ───────────────────────────────
    if (type === 'quotes') {
      const syms = (symbols || '').split(',').filter(Boolean);
      const key  = req.headers['x-fh-key'] || req.query.fhkey || '';
      const results = await Promise.allSettled(
        syms.map(s =>
          fetch(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${key}`, {
            signal: AbortSignal.timeout(6000)
          }).then(r => r.json()).then(d => ({ sym: s, c: d.c, pc: d.pc }))
        )
      );
      const data = {};
      results.forEach((r, i) => { if (r.status === 'fulfilled') data[syms[i]] = r.value; });
      return res.status(200).json(data);
    }

    // ── Candles (Yahoo Finance) ────────────────────────
    if (type === 'candles') {
      const syms = (symbols || '').split(',').filter(Boolean);
      const r    = range || '1y';
      const results = await Promise.allSettled(
        syms.map(sym => yhFetch(sym.replace(/__/g, '^'), r))
      );
      const data = {};
      results.forEach((r, i) => { if (r.status === 'fulfilled') data[syms[i]] = r.value; });
      return res.status(200).json(data);
    }

    // ── VIX (Yahoo Finance) ────────────────────────────
    if (type === 'vix') {
      const d = await yhFetch('^VIX', '5d');
      const c = (d.c || []).filter(v => v != null);
      return res.status(200).json({ vix: c.length ? +c[c.length-1].toFixed(2) : null });
    }

    // ── Breadth: McClellan from A/D + % above SMA ──────
    if (type === 'breadth') {
      // Fetch NYSE Advance, Decline, New Highs, New Lows
      // ^ANYA = Advances, ^ANYD = Declines, ^BPNYA = Bullish % (bonus)
      const [advData, decData, hlData, nya50Data, nya200Data] = await Promise.allSettled([
        yhFetch('^ANYA',   '6mo'),  // NYSE Advances
        yhFetch('^ANYD',   '6mo'),  // NYSE Declines
        yhFetch('^NYHL',   '6mo'),  // Net New Highs
        yhFetch('^NYA50R', '3mo'),  // % above 50 SMA (direct if available)
        yhFetch('^NYA200R','3mo'),  // % above 200 SMA (direct if available)
      ]);

      const getClean = result => {
        if (result.status !== 'fulfilled' || !result.value.c) return [];
        return result.value.c.filter(v => v != null && !isNaN(v));
      };

      const advArr  = getClean(advData);
      const decArr  = getClean(decData);
      const hlArr   = getClean(hlData);
      const nya50Arr = getClean(nya50Data);
      const nya200Arr= getClean(nya200Data);

      let nymo = null, nasi = null, nyhl = null, pct50 = null, pct200 = null;

      // Calculate McClellan from Advance/Decline if we got the data
      if (advArr.length > 39 && decArr.length > 39) {
        const len = Math.min(advArr.length, decArr.length);
        // Align to same length (take from end)
        const adv = advArr.slice(-len);
        const dec = decArr.slice(-len);
        const netAdv = adv.map((a, i) => a - dec[i]);

        // McClellan Oscillator = EMA(19) - EMA(39) of net advances
        const ema19 = ema(netAdv, 19);
        const ema39 = ema(netAdv, 39);
        const oscillator = ema19.map((v, i) => v - ema39[i]);

        nymo = +oscillator[oscillator.length - 1].toFixed(2);

        // McClellan Summation = cumulative sum of oscillator (starting from -1000 as conventional base)
        let sum = 0;
        const summation = oscillator.map(v => { sum += v; return sum; });
        nasi = +summation[summation.length - 1].toFixed(0);
      }

      // Net New Highs
      if (hlArr.length > 0) {
        nyhl = +hlArr[hlArr.length - 1].toFixed(0);
      }

      // % above SMA — use direct Yahoo data if available, else fallback
      if (nya50Arr.length > 0)  pct50  = +nya50Arr[nya50Arr.length - 1].toFixed(1);
      if (nya200Arr.length > 0) pct200 = +nya200Arr[nya200Arr.length - 1].toFixed(1);

      // Fallback: calculate % above SMA from sector ETFs
      if (pct50 == null || pct200 == null) {
        const sectorSyms = ['RSPG','RSPN','RSPU','RSPH','RSPR','RSPM','RSPS','RSPC','RSPD','RSPT','RSPF'];
        const sectorResults = await Promise.allSettled(
          sectorSyms.map(s => yhFetch(s, '1y'))
        );
        let above50 = 0, above200 = 0, total = 0;
        sectorResults.forEach(r => {
          if (r.status !== 'fulfilled') return;
          const c = (r.value.c || []).filter(v => v != null);
          if (c.length < 50) return;
          const price = c[c.length-1];
          const s50  = c.slice(-50).reduce((a,b)=>a+b,0) / 50;
          const s200 = c.length >= 200 ? c.slice(-200).reduce((a,b)=>a+b,0) / 200 : null;
          if (price > s50)  above50++;
          if (s200 && price > s200) above200++;
          total++;
        });
        if (total > 0) {
          if (pct50  == null) pct50  = +(above50  / total * 100).toFixed(1);
          if (pct200 == null) pct200 = +(above200 / total * 100).toFixed(1);
        }
      }

      return res.status(200).json({ nymo, nasi, nyhl, pct50, pct200 });
    }

    return res.status(400).json({ error: 'Unknown type' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
