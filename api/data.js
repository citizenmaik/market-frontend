// Market Dashboard — Vercel Serverless Proxy
// Finnhub (quotes) + Yahoo Finance (candles, vix, breadth)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, symbols, range } = req.query;
  const fhkey = process.env.FINNHUB_KEY || req.query.fhkey || '';

  // ── EMA helper ──────────────────────────────────────
  function ema(arr, n) {
    const k = 2 / (n + 1); let e = arr[0];
    const out = [e];
    for (let i = 1; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
    return out;
  }

  // ── Yahoo Finance fetch ──────────────────────────────
  async function yhFetch(sym, range2 = '1y') {
    const encodedSym = encodeURIComponent(sym);
    const rangeMap = { '5d':'5d','1mo':'1mo','3mo':'3mo','6mo':'6mo','1y':'1y','2y':'2y' };
    const r = rangeMap[range2] || '1y';
    const interval = r === '5d' ? '1d' : '1d';
    const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
    for (const host of hosts) {
      try {
        const url = `https://${host}/v8/finance/chart/${encodedSym}?range=${r}&interval=${interval}&includePrePost=false`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000)
        });
        if (!resp.ok) continue;
        const json = await resp.json();
        const q = json?.chart?.result?.[0];
        if (!q) continue;
        const c = q.indicators?.quote?.[0]?.close || [];
        const t = q.timestamp || [];
        return { c, t };
      } catch(e) { continue; }
    }
    return { c: [], t: [] };
  }

  try {
    // ── Quotes (Finnhub) ────────────────────────────────
    if (type === 'quotes') {
      const syms = (symbols || '').split(',').filter(Boolean);
      const results = await Promise.allSettled(
        syms.map(s =>
          fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${fhkey}`)
            .then(r => r.json()).then(d => ({ sym: s, c: d.c, pc: d.pc }))
        )
      );
      const data = {};
      results.forEach((r, i) => { if (r.status === 'fulfilled') data[syms[i]] = r.value; });
      return res.status(200).json(data);
    }

    // ── VIX ─────────────────────────────────────────────
    if (type === 'vix') {
      const d = await yhFetch('^VIX', '5d');
      const c = (d.c || []).filter(v => v != null);
      return res.status(200).json({ vix: c.length ? +c[c.length-1].toFixed(2) : null });
    }

    // ── Candles (Yahoo Finance) ──────────────────────────
    if (type === 'candles') {
      const syms = (symbols || '').split(',').map(s => s.replace(/__/g, '^'));
      const r2 = range || '1y';
      const results = await Promise.allSettled(syms.map(s => yhFetch(s, r2)));
      const data = {};
      syms.forEach((s, i) => {
        const key = s.replace(/\^/g, '__');
        data[key] = results[i].status === 'fulfilled' ? results[i].value : { c: [], t: [] };
      });
      return res.status(200).json(data);
    }

    // ── Breadth ──────────────────────────────────────────
    if (type === 'breadth') {
      // Fetch multiple breadth indicators in parallel
      // ^SPXAD = S&P 500 A/D, ^NYAD = NYSE A/D line, ^BPSPX = Bullish % S&P500
      // NYA50R/NYA200R = % NYSE stocks above 50/200 SMA
      const [nymoRes, nasiRes, nyhlRes, nya50Res, nya200Res, spxadRes] = await Promise.allSettled([
        yhFetch('^NYMO',   '3mo'),   // McClellan Oscillator
        yhFetch('^NASI',   '3mo'),   // McClellan Summation
        yhFetch('^NYHL',   '5d'),    // Net New Highs (NYSE)
        yhFetch('^NYA50R', '3mo'),   // % NYSE above 50 SMA
        yhFetch('^NYA200R','3mo'),   // % NYSE above 200 SMA
        yhFetch('^SPXAD',  '3mo'),   // S&P 500 Advance/Decline
      ]);

      const getClean = r => r.status === 'fulfilled' ? (r.value.c||[]).filter(v=>v!=null&&!isNaN(v)) : [];

      const nymoArr  = getClean(nymoRes);
      const nasiArr  = getClean(nasiRes);
      const nyhlArr  = getClean(nyhlRes);
      const nya50Arr = getClean(nya50Res);
      const nya200Arr= getClean(nya200Res);
      const spxadArr = getClean(spxadRes);

      let nymo=null, nasi=null, nyhl=null, pct50=null, pct200=null;

      // McClellan Oscillator — try direct first
      if (nymoArr.length > 0) nymo = +nymoArr[nymoArr.length-1].toFixed(2);

      // McClellan Summation
      if (nasiArr.length > 0) nasi = +nasiArr[nasiArr.length-1].toFixed(0);

      // Net New Highs
      if (nyhlArr.length > 0) nyhl = +nyhlArr[nyhlArr.length-1].toFixed(0);

      // % above 50/200 SMA
      if (nya50Arr.length > 0)  pct50  = +nya50Arr[nya50Arr.length-1].toFixed(1);
      if (nya200Arr.length > 0) pct200 = +nya200Arr[nya200Arr.length-1].toFixed(1);

      // Fallback: calculate % above SMA from sector ETFs (RSP equal-weight sectors)
      if (pct50 == null || pct200 == null || nymo == null) {
        const sectorSyms = ['RSPG','RSPN','RSPU','RSPH','RSPR','RSPM','RSPS','RSPC','RSPD','RSPT','RSPF'];
        const sectorRes = await Promise.allSettled(sectorSyms.map(s => yhFetch(s, '1y')));
        let above50=0, above200=0, total=0;
        sectorRes.forEach(r => {
          if (r.status !== 'fulfilled') return;
          const c = (r.value.c||[]).filter(v=>v!=null);
          if (c.length < 50) return;
          const price = c[c.length-1];
          const s50  = c.slice(-50).reduce((a,b)=>a+b,0)/50;
          const s200 = c.length>=200 ? c.slice(-200).reduce((a,b)=>a+b,0)/200 : null;
          if (price > s50)  above50++;
          if (s200 && price > s200) above200++;
          total++;
        });
        if (total > 0) {
          if (pct50  == null) pct50  = +(above50/total*100).toFixed(1);
          if (pct200 == null) pct200 = +(above200/total*100).toFixed(1);
        }

        // McClellan fallback: use S&P 500 A/D momentum as proxy
        // Calculate rate of change of A/D line as oscillator proxy
        if (nymo == null && spxadArr.length > 39) {
          const ema19 = ema(spxadArr, 19);
          const ema39 = ema(spxadArr, 39);
          // Normalize to McClellan-like scale
          const osc = ema19[ema19.length-1] - ema39[ema39.length-1];
          const range2 = Math.max(...spxadArr.slice(-60)) - Math.min(...spxadArr.slice(-60));
          nymo = range2 > 0 ? +(osc / range2 * 100).toFixed(2) : null;

          // Summation from oscillator
          if (nymo != null) {
            let sum = 0;
            const ema19all = ema(spxadArr, 19);
            const ema39all = ema(spxadArr, 39);
            ema19all.forEach((v,i) => { sum += (v - ema39all[i]); });
            nasi = +(sum / range2 * 100).toFixed(0);
          }
        }
      }

      // Net New Highs fallback: calculate from sector ETFs hitting 52W highs
      if (nyhl == null) {
        const sectorSyms2 = ['RSPG','RSPN','RSPU','RSPH','RSPR','RSPM','RSPS','RSPC','RSPD','RSPT','RSPF'];
        const sectorRes2 = await Promise.allSettled(sectorSyms2.map(s => yhFetch(s, '1y')));
        let newHighs=0, newLows=0;
        sectorRes2.forEach(r => {
          if (r.status !== 'fulfilled') return;
          const c = (r.value.c||[]).filter(v=>v!=null);
          if (c.length < 20) return;
          const price = c[c.length-1];
          const high52 = Math.max(...c.slice(-252));
          const low52  = Math.min(...c.slice(-252));
          if (price >= high52 * 0.98) newHighs++;
          if (price <= low52  * 1.02) newLows++;
        });
        nyhl = newHighs - newLows;
      }

      return res.status(200).json({ nymo, nasi, nyhl, pct50, pct200 });
    }

    return res.status(400).json({ error: 'Unknown type' });
  } catch(err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
