
// fetcher.js - 5M Data Fetcher with Local Caching (Coinbase / No Proxies - SOL ONLY)
const ccxt = require('ccxt');
const fs = require('fs');

// Initialize Coinbase with CCXT's built-in rate limiter enabled
const exchange = new ccxt.coinbase({ enableRateLimit: true });

const TIMEFRAME = '5m';
const TARGET_CANDLES = 200000;
const ASSET = 'sol';
const SYMBOL = 'SOL/USD';
const CACHE_FILENAME = 'sol_usdt_cache.json'; // Kept as usdt to match backtester logic

async function fetchAssetData() {
    let allCandles = [];

    // 1. Check for existing cache file first
    if (fs.existsSync(CACHE_FILENAME)) {
        console.log(`📦 Local cache found for SOL! Loading ${CACHE_FILENAME}...`);
        try {
            allCandles = JSON.parse(fs.readFileSync(CACHE_FILENAME, 'utf8'));
            console.log(`✅ Loaded ${allCandles.length} ${TIMEFRAME} candles from disk for SOL.`);
            return allCandles;
        } catch (err) {
            console.log(`⚠️ Cache file corrupted for SOL. Deleting and re-fetching...`);
            fs.unlinkSync(CACHE_FILENAME);
        }
    }

    // 2. Time math for 5-minute candles (5 mins * 60 secs * 1000 ms)
    let since = exchange.milliseconds() - (TARGET_CANDLES * 5 * 60 * 1000); 
    console.log(`🚀 Fetching ~${TARGET_CANDLES} ${TIMEFRAME} candles for ${SYMBOL} from Coinbase...`);

    while (allCandles.length < TARGET_CANDLES) {
        try {
            const batch = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, since);
            
            if (!batch || batch.length === 0) break;
            
            allCandles = allCandles.concat(batch);
            since = batch[batch.length - 1][0] + 1; 
            
            console.log(`📥 [SOL] Fetched ${batch.length} | Total: ${allCandles.length} / ${TARGET_CANDLES}`);

            if (since > exchange.milliseconds()) break; 
            await exchange.sleep(300); // Respect API limits
            
        } catch (e) {
            console.log(`⚠️ Hit an error or limit: ${e.message}. Pausing for 5 seconds...`);
            await exchange.sleep(5000); 
        }
    }

    // 3. Save the fetched data to the cache file
    if (allCandles.length > 50) {
        fs.writeFileSync(CACHE_FILENAME, JSON.stringify(allCandles));
        console.log(`✅ Cached ${allCandles.length} candles to ${CACHE_FILENAME}.`);
    } else {
        console.log(`❌ Failed to fetch enough data for SOL.`);
    }
    
    return allCandles;
}

async function start() {
    console.log(`\n======================================================`);
    console.log(`Starting Fetch for SOL`);
    console.log(`======================================================`);
    await fetchAssetData();
    console.log(`\n🎉 Fetch complete! Your ML backtester is ready to run.`);
}

start();
