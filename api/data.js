// Finnhub API Route
export default async function handler(req, res) {
  const { type, symbols, range, fhkey } = req.query;
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const FINNHUB_API_KEY = fhkey || process.env.FINNHUB_API_KEY;
  
  if (!FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'API Key not configured' });
  }
  
  try {
    // QUOTES
    if (type === 'quotes' && symbols) {
      const symbolList = symbols.split(',');
      const quotes = {};
      
      await Promise.all(
        symbolList.map(async (symbol) => {
          const url = `https://finnhub.io/api/v1/quote?symbol=${symbol.trim()}&token=${FINNHUB_API_KEY}`;
          const response = await fetch(url);
          const data = await response.json();
          quotes[symbol.trim()] = data;
        })
      );
      
      return res.status(200).json(quotes);
    }
    
    // VIX
    if (type === 'vix') {
      const url = `https://finnhub.io/api/v1/quote?symbol=^VIX&token=${FINNHUB_API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();
      return res.status(200).json(data);
    }
    
    // BREADTH
    if (type === 'breadth') {
      const breadthData = {};
      const breadthSymbols = ['ADVN.US', 'DECN.US', 'ADVU.US', 'DECU.US'];
      
      await Promise.all(
        breadthSymbols.map(async (symbol) => {
          const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`;
          const response = await fetch(url);
          const data = await response.json();
          breadthData[symbol] = data;
        })
      );
      
      return res.status(200).json(breadthData);
    }
    
    // CANDLES
    if (type === 'candles' && symbols && range) {
      const symbolList = symbols.split(',');
      const candles = {};
      
      const now = Math.floor(Date.now() / 1000);
      const periods = {
        '1D': 24 * 3600,
        '5D': 5 * 24 * 3600,
        '1M': 30 * 24 * 3600,
        '3M': 90 * 24 * 3600,
        '6M': 180 * 24 * 3600,
        'YTD': Math.floor((now - new Date(new Date().getFullYear(), 0, 1) / 1000)),
        '1Y': 365 * 24 * 3600,
        '5Y': 5 * 365 * 24 * 3600
      };
      
      const from = now - (periods[range] || periods['1M']);
      const resolution = range === '1D' ? '5' : range === '5D' ? '15' : 'D';
      
      await Promise.all(
        symbolList.map(async (symbol) => {
          const url = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol.trim()}&resolution=${resolution}&from=${from}&to=${now}&token=${FINNHUB_API_KEY}`;
          const response = await fetch(url);
          const data = await response.json();
          candles[symbol.trim()] = data;
        })
      );
      
      return res.status(200).json(candles);
    }
    
    return res.status(400).json({ error: 'Invalid request' });
    
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: 'API request failed' });
  }
}
