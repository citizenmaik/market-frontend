// Finnhub API Route für Live-Preise
export default async function handler(req, res) {
  const { type, symbols } = req.query;
  
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  if (type === 'quotes' && symbols) {
    const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
    
    if (!FINNHUB_API_KEY) {
      return res.status(500).json({ error: 'API Key not configured' });
    }
    
    try {
      const symbolList = symbols.split(',');
      const quotes = {};
      
      // Fetch quotes für alle Symbole
      await Promise.all(
        symbolList.map(async (symbol) => {
          const url = `https://finnhub.io/api/v1/quote?symbol=${symbol.trim()}&token=${FINNHUB_API_KEY}`;
          const response = await fetch(url);
          const data = await response.json();
          quotes[symbol.trim()] = data;
        })
      );
      
      return res.status(200).json(quotes);
      
    } catch (error) {
      console.error('Finnhub API error:', error);
      return res.status(500).json({ error: 'Failed to fetch quotes' });
    }
  }
  
  return res.status(400).json({ error: 'Invalid request' });
}
