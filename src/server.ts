import express, { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

app.use(cors());
app.use(express.json());

// Cache configuration
const CACHE_CONFIG = {
  CURRENT_PRICE_TTL: 5 * 60 * 1000, // 5 minutes for current price
  HISTORICAL_DATA_TTL: 30 * 60 * 1000, // 30 minutes for historical data
  DATE_SPECIFIC_TTL: 24 * 60 * 60 * 1000, // 24 hours for specific dates (historical data rarely changes)
  MAX_CACHE_SIZE: 1000, // Maximum number of cache entries
  CLEANUP_INTERVAL: 60 * 60 * 1000, // Clean up expired entries every hour
};

// Unit conversion constants (all based on troy ounce)
const UNIT_CONVERSIONS = {
  oz: 1, // troy ounce (base unit)
  g: 31.1035, // grams per troy ounce
  kg: 0.0311035, // kilograms per troy ounce
} as const;

type WeightUnit = keyof typeof UNIT_CONVERSIONS;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  key: string;
}

interface FMPHistoricalData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose: number;
  volume: number;
  unadjustedVolume: number;
  change: number;
  changePercent: number;
  vwap: number;
  label: string;
  changeOverTime: number;
}

interface FMPQuote {
  symbol: string;
  name: string;
  price: number;
  changesPercentage: number;
  change: number;
  dayLow: number;
  dayHigh: number;
  yearHigh: number;
  yearLow: number;
  marketCap: number;
  priceAvg50: number;
  priceAvg200: number;
  volume: number;
  avgVolume: number;
  exchange: string;
  open: number;
  previousClose: number;
  timestamp: number;
}

interface GoldDataPoint {
  date: string;
  price: number;
  displayDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface GoldPriceResponse {
  currentPrice: number;
  priceChange: number;
  percentChange: number;
  data: GoldDataPoint[];
  timestamp: number;
  unit: WeightUnit;
  unitLabel: string;
}

// In-memory cache
class MemoryCache {
  private cache = new Map<string, CacheEntry<any>>();
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, CACHE_CONFIG.CLEANUP_INTERVAL);
  }

  set<T>(key: string, data: T, ttl: number): void {
    // If cache is getting too large, remove oldest entries
    if (this.cache.size >= CACHE_CONFIG.MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
      key,
    });
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach((key) => this.cache.delete(key));

    if (keysToDelete.length > 0) {
      console.log(
        `🧹 Cache cleanup: removed ${keysToDelete.length} expired entries`,
      );
    }
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: CACHE_CONFIG.MAX_CACHE_SIZE,
      entries: Array.from(this.cache.entries()).map(([key, entry]) => ({
        key,
        age: Date.now() - entry.timestamp,
        ttl: entry.ttl,
        expired: Date.now() - entry.timestamp > entry.ttl,
      })),
    };
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.clear();
  }
}

const cache = new MemoryCache();

// Helper function to convert price based on unit
const convertPrice = (pricePerOz: number, targetUnit: WeightUnit): number => {
  const conversionFactor = UNIT_CONVERSIONS[targetUnit];
  return Math.round((pricePerOz / conversionFactor) * 100) / 100;
};

// Helper function to get unit label
const getUnitLabel = (unit: WeightUnit): string => {
  const labels = {
    oz: 'per troy ounce',
    g: 'per gram',
    kg: 'per kilogram',
  };
  return labels[unit];
};

// Helper function to validate unit parameter
const validateUnit = (unit: string): WeightUnit => {
  const lowerUnit = unit.toLowerCase();
  if (!Object.keys(UNIT_CONVERSIONS).includes(lowerUnit)) {
    throw new Error(
      `Invalid unit. Supported units: ${Object.keys(UNIT_CONVERSIONS).join(
        ', ',
      )}`,
    );
  }
  return lowerUnit as WeightUnit;
};

const getDateRange = (timeframe: string): { start: string; end: string } => {
  const endDate = new Date();
  const startDate = new Date();

  switch (timeframe) {
    case '1D':
      startDate.setDate(endDate.getDate() - 1);
      break;
    case '1W':
      startDate.setDate(endDate.getDate() - 7);
      break;
    case '1M':
      startDate.setMonth(endDate.getMonth() - 1);
      break;
    case '3M':
      startDate.setMonth(endDate.getMonth() - 3);
      break;
    case '6M':
      startDate.setMonth(endDate.getMonth() - 6);
      break;
    case '1Y':
      startDate.setFullYear(endDate.getFullYear() - 1);
      break;
    case 'ALL':
      startDate.setFullYear(endDate.getFullYear() - 5);
      break;
    default:
      startDate.setMonth(endDate.getMonth() - 1);
  }

  return {
    start: startDate.toISOString().split('T')[0],
    end: endDate.toISOString().split('T')[0],
  };
};

// Helper function to fetch current gold price with caching
const fetchCurrentGoldPrice = async (): Promise<FMPQuote> => {
  const cacheKey = 'current_gold_price';
  const cachedData = cache.get<FMPQuote>(cacheKey);

  if (cachedData) {
    console.log('📦 Using cached current gold price');
    return cachedData;
  }

  console.log('🌐 Fetching fresh current gold price from API');

  const [gldResponse, goldResponse] = await Promise.allSettled([
    axios.get<FMPQuote[]>(`${FMP_BASE_URL}/quote/GLD`, {
      params: { apikey: FMP_API_KEY },
    }),
    axios.get<FMPQuote[]>(`${FMP_BASE_URL}/quote/GCUSD`, {
      params: { apikey: FMP_API_KEY },
    }),
  ]);

  let goldData: FMPQuote | null = null;

  if (goldResponse.status === 'fulfilled' && goldResponse.value.data[0])
    goldData = goldResponse.value.data[0];
  else if (gldResponse.status === 'fulfilled' && gldResponse.value.data[0])
    goldData = gldResponse.value.data[0];

  if (!goldData) {
    throw new Error('No gold data available from API');
  }

  // Cache the result
  cache.set(cacheKey, goldData, CACHE_CONFIG.CURRENT_PRICE_TTL);

  return goldData;
};

// Helper function to fetch historical data with caching
const fetchHistoricalData = async (
  timeframe: string,
): Promise<FMPHistoricalData[]> => {
  const cacheKey = `historical_${timeframe}`;
  const cachedData = cache.get<FMPHistoricalData[]>(cacheKey);

  if (cachedData) {
    console.log(`📦 Using cached historical data for ${timeframe}`);
    return cachedData;
  }

  console.log(`🌐 Fetching fresh historical data for ${timeframe} from API`);

  const { start, end } = getDateRange(timeframe);
  let historicalData: FMPHistoricalData[] = [];

  try {
    const response = await axios.get<FMPHistoricalData[]>(
      `${FMP_BASE_URL}/historical-price-full/GCUSD`,
      {
        params: {
          apikey: FMP_API_KEY,
          from: start,
          to: end,
        },
      },
    );

    if (response.data && Array.isArray(response.data))
      historicalData = response.data;
    else if (response.data && (response.data as any).historical)
      historicalData = (response.data as any).historical;
  } catch (error) {
    const response = await axios.get<FMPHistoricalData[]>(
      `${FMP_BASE_URL}/historical-price-full/GLD`,
      {
        params: {
          apikey: FMP_API_KEY,
          from: start,
          to: end,
        },
      },
    );

    if (response.data && Array.isArray(response.data))
      historicalData = response.data;
    else if (response.data && (response.data as any).historical)
      historicalData = (response.data as any).historical;
  }

  if (!historicalData || historicalData.length === 0) {
    throw new Error('No historical data available from API');
  }

  // Cache the result
  cache.set(cacheKey, historicalData, CACHE_CONFIG.HISTORICAL_DATA_TTL);

  return historicalData;
};

// Helper function to fetch date-specific data with caching
const fetchDateSpecificData = async (
  date: string,
): Promise<FMPHistoricalData> => {
  const cacheKey = `date_${date}`;
  const cachedData = cache.get<FMPHistoricalData>(cacheKey);

  if (cachedData) {
    console.log(`📦 Using cached data for date ${date}`);
    return cachedData;
  }

  console.log(`🌐 Fetching fresh data for date ${date} from API`);

  const response = await axios.get(
    `${FMP_BASE_URL}/historical-price-full/GCUSD`,
    {
      params: {
        apikey: FMP_API_KEY,
        from: date,
        to: date,
      },
    },
  );

  const historicalData = response.data?.historical || response.data;
  const dateData = Array.isArray(historicalData) ? historicalData[0] : null;

  if (!dateData) {
    throw new Error(`No data found for date ${date}`);
  }

  // Cache the result with longer TTL since historical data doesn't change
  cache.set(cacheKey, dateData, CACHE_CONFIG.DATE_SPECIFIC_TTL);

  return dateData;
};

// Routes with caching and unit support
app.get('/api/gold/current', async (req: Request, res: Response) => {
  try {
    const { unit = 'oz' } = req.query;
    let targetUnit: WeightUnit;

    try {
      targetUnit = validateUnit(unit as string);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid unit parameter',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    const goldData = await fetchCurrentGoldPrice();

    // Convert prices to target unit (conversion is done on cached data)
    const convertedPrice = convertPrice(goldData.price, targetUnit);
    const convertedChange = convertPrice(goldData.change, targetUnit);
    const convertedOpen = convertPrice(goldData.open, targetUnit);
    const convertedHigh = convertPrice(goldData.dayHigh, targetUnit);
    const convertedLow = convertPrice(goldData.dayLow, targetUnit);
    const convertedPreviousClose = convertPrice(
      goldData.previousClose,
      targetUnit,
    );

    const responseData: any = {
      success: true,
      data: {
        gold: {
          price: convertedPrice,
          currency: 'USD',
          unit: getUnitLabel(targetUnit),
          unitCode: targetUnit,
          priceChange: convertedChange,
          percentChange: goldData.changesPercentage, // Percentage stays the same
          open: convertedOpen,
          high: convertedHigh,
          low: convertedLow,
          previousClose: convertedPreviousClose,
          volume: goldData.volume,
        },
        timestamp: goldData.timestamp,
        cached: cache.has('current_gold_price'),
      },
    };

    return res.json(responseData);
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch current gold price',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/gold/historical', async (req: Request, res: Response) => {
  try {
    const { timeframe = '1M', unit = 'oz' } = req.query;
    let targetUnit: WeightUnit;

    try {
      targetUnit = validateUnit(unit as string);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid unit parameter',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    const historicalData = await fetchHistoricalData(timeframe as string);

    const chartData: GoldDataPoint[] = historicalData
      .map((item) => ({
        date: item.date,
        price: convertPrice(item.close, targetUnit),
        displayDate: new Date(item.date).toLocaleDateString(),
        open: convertPrice(item.open, targetUnit),
        high: convertPrice(item.high, targetUnit),
        low: convertPrice(item.low, targetUnit),
        close: convertPrice(item.close, targetUnit),
      }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let priceChange = 0;
    let percentChange = 0;

    if (chartData.length > 1) {
      const firstPrice = chartData[0].price;
      const lastPrice = chartData[chartData.length - 1].price;
      priceChange = Math.round((lastPrice - firstPrice) * 100) / 100;
      percentChange = Math.round((priceChange / firstPrice) * 100 * 100) / 100;
    }

    const responseData: GoldPriceResponse = {
      currentPrice: chartData[chartData.length - 1]?.price || 0,
      priceChange,
      percentChange,
      data: chartData,
      timestamp: Date.now(),
      unit: targetUnit,
      unitLabel: getUnitLabel(targetUnit),
    };

    return res.json({
      success: true,
      timeframe,
      data: responseData,
      cached: cache.has(`historical_${timeframe}`),
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch historical gold prices',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/gold/fluctuation', async (req: Request, res: Response) => {
  try {
    const { timeframe = '1M', unit = 'oz' } = req.query;
    let targetUnit: WeightUnit;

    try {
      targetUnit = validateUnit(unit as string);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid unit parameter',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    const historicalData = await fetchHistoricalData(timeframe as string);
    const { start, end } = getDateRange(timeframe as string);

    const sortedData = historicalData.sort(
      (a: any, b: any) =>
        new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    const startPrice = convertPrice(sortedData[0].close, targetUnit);
    const endPrice = convertPrice(
      sortedData[sortedData.length - 1].close,
      targetUnit,
    );
    const change = Math.round((endPrice - startPrice) * 100) / 100;
    const changePercent = Math.round((change / startPrice) * 100 * 100) / 100;

    return res.json({
      success: true,
      timeframe,
      period: { start, end },
      unit: targetUnit,
      unitLabel: getUnitLabel(targetUnit),
      data: {
        gold: {
          startPrice,
          endPrice,
          change,
          changePercent,
        },
      },
      cached: cache.has(`historical_${timeframe}`),
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch fluctuation data',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/gold/date/:date', async (req: Request, res: Response) => {
  try {
    const { date } = req.params;
    const { unit = 'oz' } = req.query;
    let targetUnit: WeightUnit;

    try {
      targetUnit = validateUnit(unit as string);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid unit parameter',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date))
      return res.status(400).json({
        error: 'Invalid date format',
        message: 'Date must be in YYYY-MM-DD format',
      });

    const dateData = await fetchDateSpecificData(date);

    return res.json({
      success: true,
      date,
      unit: targetUnit,
      unitLabel: getUnitLabel(targetUnit),
      data: {
        gold: {
          price: convertPrice(dateData.close, targetUnit),
          currency: 'USD',
          unit: getUnitLabel(targetUnit),
          open: convertPrice(dateData.open, targetUnit),
          high: convertPrice(dateData.high, targetUnit),
          low: convertPrice(dateData.low, targetUnit),
          volume: dateData.volume,
        },
        timestamp: Date.now(),
        cached: cache.has(`date_${date}`),
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch gold price for specified date',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Endpoint to get supported units
app.get('/api/gold/units', (req: Request, res: Response) => {
  return res.json({
    success: true,
    supportedUnits: Object.keys(UNIT_CONVERSIONS).map((unit) => ({
      code: unit,
      label: getUnitLabel(unit as WeightUnit),
      conversionFactor: UNIT_CONVERSIONS[unit as WeightUnit],
    })),
    defaultUnit: 'oz',
    baseUnit: 'troy ounce',
  });
});

// Cache management endpoints
app.get('/api/cache/stats', (req: Request, res: Response) => {
  return res.json({
    success: true,
    cache: cache.getStats(),
    config: {
      currentPriceTTL: CACHE_CONFIG.CURRENT_PRICE_TTL,
      historicalDataTTL: CACHE_CONFIG.HISTORICAL_DATA_TTL,
      dateSpecificTTL: CACHE_CONFIG.DATE_SPECIFIC_TTL,
      maxCacheSize: CACHE_CONFIG.MAX_CACHE_SIZE,
    },
  });
});

app.post('/api/cache/clear', (req: Request, res: Response) => {
  cache.clear();
  return res.json({
    success: true,
    message: 'Cache cleared successfully',
  });
});

app.get('/health', (req: Request, res: Response) => {
  return res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    apiConfigured: !!FMP_API_KEY,
    cacheSize: cache.getStats().size,
    uptime: process.uptime(),
  });
});

app.use((err: Error, req: Request, res: Response, next: any) => {
  return res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

app.use('*', (req: Request, res: Response) => {
  return res.json({
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /api/gold/current?unit=oz|g|kg',
      'GET /api/gold/historical?timeframe=1M&unit=oz|g|kg',
      'GET /api/gold/fluctuation?timeframe=1M&unit=oz|g|kg',
      'GET /api/gold/date/:date?unit=oz|g|kg',
      'GET /api/gold/units',
      'GET /api/cache/stats',
      'POST /api/cache/clear',
      'GET /health',
    ],
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Gracefully shutting down...');
  cache.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Gracefully shutting down...');
  cache.destroy();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 Gold Price API Server running on port ${PORT}`);
  console.log(`📊 API Key configured: ${!!FMP_API_KEY}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(
    `⚖️  Supported units: ${Object.keys(UNIT_CONVERSIONS).join(', ')}`,
  );
  console.log(`💾 Cache configuration:`);
  console.log(
    `   - Current price TTL: ${CACHE_CONFIG.CURRENT_PRICE_TTL / 1000}s`,
  );
  console.log(
    `   - Historical data TTL: ${CACHE_CONFIG.HISTORICAL_DATA_TTL / 1000}s`,
  );
  console.log(
    `   - Date-specific TTL: ${CACHE_CONFIG.DATE_SPECIFIC_TTL / 1000}s`,
  );
  console.log(`   - Max cache size: ${CACHE_CONFIG.MAX_CACHE_SIZE} entries`);
});
