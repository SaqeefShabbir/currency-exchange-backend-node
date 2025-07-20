// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// Validate required environment variables
const requiredEnvVars = ['FREE_CURRENCY_API_KEY'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`ERROR: Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiter configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again after 15 minutes'
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(limiter);

// Configuration object with environment variables
const config = {
  api: {
    key: process.env.FREE_CURRENCY_API_KEY,
    baseUrl: 'https://api.freecurrencyapi.com/v1'
  },
  app: {
    port: PORT,
    env: process.env.NODE_ENV || 'development',
    cacheExpiration: process.env.CACHE_EXPIRATION || 5 * 60 * 1000 // 5 minutes
  }
};

// Error handling middleware
app.use((err: any, req: any, res: any, next: any) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'Something went wrong!' });
});

interface CurrencyCache {
  currencies: any,
  rates: any,
  baseCurrency: any,
  lastUpdated: any,
}

// Cache for storing currencies and rates
let currencyCache: CurrencyCache = {
  currencies: null,
  rates: null,
  baseCurrency: null,
  lastUpdated: null,
};

// Cache expiration time (5 minutes)
const CACHE_EXPIRATION = 5 * 60 * 1000;

// Helper function to fetch all currencies
async function fetchAllCurrencies() {
  try {
    const response = await axios.get(`${config.api.baseUrl}/currencies`, {
      params: { apikey: config.api.key }
    });
    return response.data.data;
  } catch (error: any) {
    console.error('Error fetching currencies:', error.message);
    throw new Error('Failed to fetch currency list');
  }
}

// Helper function to fetch all rates
async function fetchAllRates(baseCurrency = 'USD') {
  try {
    const response = await axios.get(`${config.api.baseUrl}/latest`, {
      params: {
        apikey: config.api.key,
        base_currency: baseCurrency
      }
    });
    return response.data.data;
  } catch (error: any) {
    console.error('Error fetching rates:', error.message);
    throw new Error('Failed to fetch exchange rates');
  }
}

// Middleware to check and update cache
async function updateCache(baseCurrency = 'USD') {
  const now = Date.now();
  
  if (!currencyCache.currencies || !currencyCache.lastUpdated || 
      (now - currencyCache.lastUpdated) > CACHE_EXPIRATION) {
    try {
      const [currencies, rates] = await Promise.all([
        fetchAllCurrencies(),
        fetchAllRates(baseCurrency)
      ]);
      
      currencyCache = {
        currencies,
        rates,
        lastUpdated: now,
        baseCurrency
      };
    } catch (error: any) {
      throw error;
    }
  } else if (currencyCache.baseCurrency !== baseCurrency) {
    try {
      currencyCache.rates = await fetchAllRates(baseCurrency);
      currencyCache.baseCurrency = baseCurrency;
      currencyCache.lastUpdated = now;
    } catch (error: any) {
      throw error;
    }
  }
}

// Routes
app.get('/api/currencies', async (req: any, res: any) => {
  try {
    await updateCache();
    res.json({
      success: true,
      currencies: currencyCache.currencies
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/rates', async (req: any, res: any) => {
  try {
    const { base = 'USD' } = req.query;
    await updateCache(base);
    res.json({
      success: true,
      base: currencyCache.baseCurrency,
      rates: currencyCache.rates
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/convert/:from/:to/:amount', async (req: any, res: any) => {
  try {
    const { from, to, amount = 1 } = req.params;
    const numericAmount = parseFloat(amount);
    
    if (isNaN(numericAmount)) {
      throw new Error('Amount must be a number');
    }

    // First get rate from FROM currency to USD (base)
    await updateCache('USD');
    const usdRates = currencyCache.rates;
    
    // Check if currencies exist
    if (!currencyCache.currencies[from] || !currencyCache.currencies[to]) {
      throw new Error('Invalid currency code');
    }

    // Calculate conversion through USD as intermediate
    const fromToUsd = from === 'USD' ? 1 : (1 / usdRates[from]);
    const usdToTo = to === 'USD' ? 1 : usdRates[to];
    const rate = fromToUsd * usdToTo;
    const result = numericAmount * rate;

    res.json({
      success: true,
      conversion: {
        from,
        to,
        amount: numericAmount,
        rate,
        result
      }
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Bulk conversion endpoint
app.post('/api/convert/bulk', async (req: any, res: any) => {
  try {
    const { from, amounts } = req.body;
    
    if (!from || !amounts || typeof amounts !== 'object') {
      throw new Error('Invalid request format. Expected { from: "CUR", amounts: { "CUR": amount } }');
    }

    await updateCache('USD');
    const usdRates = currencyCache.rates;
    
    if (!currencyCache.currencies[from]) {
      throw new Error(`Invalid source currency: ${from}`);
    }

    const results: any = {};
    const fromToUsd = from === 'USD' ? 1 : (1 / usdRates[from]);

    for (const [currency, amount] of Object.entries(amounts)) {
      if (!currencyCache.currencies[currency]) {
        results[currency] = { error: 'Invalid currency code' };
        continue;
      }

      const numericAmount = parseFloat(amount as any);
      if (isNaN(numericAmount)) {
        results[currency] = { error: 'Amount must be a number' };
        continue;
      }

      const usdToCurrency = currency === 'USD' ? 1 : usdRates[currency];
      const rate = fromToUsd * usdToCurrency;
      const result = numericAmount * rate;

      results[currency] = {
        amount: numericAmount,
        rate,
        result
      };
    }

    res.json({
      success: true,
      from,
      results
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Add this interface at the top
interface ConversionRecord {
  userId?: string; // Optional for future user-specific storage
  fromCurrency: string;
  toCurrency: string;
  amount: number;
  result: number;
  rate: number;
  timestamp: Date;
}

// In-memory store (replace with database in production)
const conversionHistoryStore: Record<string, ConversionRecord[]> = {};

// Add these new endpoints
app.post('/api/history', async (req: any, res: any) => {
  try {
    const { userId = 'anonymous', conversion } = req.body;
    
    if (!conversionHistoryStore[userId]) {
      conversionHistoryStore[userId] = [];
    }
    
    const record = {
      ...conversion,
      timestamp: new Date()
    };
    
    conversionHistoryStore[userId].unshift(record);
    
    // Keep only the last 20 records
    conversionHistoryStore[userId] = conversionHistoryStore[userId].slice(0, 20);
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/history', async (req: any, res: any) => {
  try {
    const { userId = 'anonymous' } = req.query;
    const history = conversionHistoryStore[userId] || [];
    res.json({ success: true, history });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/history', async (req: any, res: any) => {
  try {
    const { userId = 'anonymous' } = req.query;
    delete conversionHistoryStore[userId];
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port :${PORT}`);
});