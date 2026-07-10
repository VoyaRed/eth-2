// fetcher.js - 3H Data Fetcher with Local Caching
const ccxt = require('ccxt');
const { Impit } = require('impit');
const fs = require('fs');

const PROXY_POOL = [
    'http://zirrujpi-ch-532845:8e2wprq017db@p.webshare.io:80',
    'http://zirrujpi-ch-532846:8e2wprq017db@p.webshare.io:80',
    'http://zirrujpi-ch-532847:8e2wprq017db@p.webshare.io:80',
    'http://zirrujpi-ch-532848:8e2wprq017db@p.webshare.io:80',
    'http://zirrujpi-ch-532849:8e2wprq017db@p.webshare.io:80',
    'http://zirrujpi-ch-532850:8e2wprq017db@p.webshare.io:80',
    'http://zirrujpi-ch-532851:8e2wprq017db@p.webshare.io:80',
    'http://zirrujpi-ch-532852:8e2wprq017db@p.webshare.io:80',
    'http://zirrujpi-ch-532853:8e2wprq017db@p.webshare.io:80',
    'http://zirrujpi-ch-532854:8e2wprq017db@p.webshare.io:80'                             
];

let activeImpersonator = null;

// Safe Fetch Wrapper for Proxies
const safeFetch = async (url, options = {}) => {
    if (!activeImpersonator) return new Response(JSON.stringify({ error: "No proxy" }), { status: 500 });
    try {
        options.headers = options.headers || {};
        Object.assign(options.headers, {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json'
        });
        return await activeImpersonator.fetch(url, options);
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502 });
    }
};

class DummyFetchError extends Error {}
safeFetch.FetchError = DummyFetchError;
safeFetch.Headers = globalThis.Headers || Map;
safeFetch.Request = globalThis.Request || Object;
safeFetch.Response = globalThis.Response || Object;

const exchange = new ccxt.binance({
    fetchImplementation: safeFetch,
    enableRateLimit: true,
    options: { defaultType: 'spot' } 
});

// ------------------------------------------------------------------
// MODULE 1: HISTORICAL BACKTEST (MATRIX OPTIMIZATION)
// ------------------------------------------------------------------
async function runBacktest() {
    const CACHE_FILENAME = 'sol_usdt_cache_3h.json';
    let allCandles = [];

    // 1. Check for existing cache file first
    if (fs.existsSync(CACHE_FILENAME)) {
        console.log(`📦 Local cache found! Loading ${CACHE_FILENAME}...`);
        try {
            allCandles = JSON.parse(fs.readFileSync(CACHE_FILENAME, 'utf8'));
            console.log(`✅ Successfully loaded ${allCandles.length} 3H candles from disk.`);
            return allCandles; // Return the data and skip fetching
        } catch (err) {
            console.log("⚠️ Cache file corrupted. Deleting and re-fetching...");
            fs.unlinkSync(CACHE_FILENAME);
        }
    }

    // 2. If no cache, fetch data from exchange
    const overallCandleTarget = PROXY_POOL.length * 5000;
    
    // Time math updated for 3-hour candles (3 hours = 3 * 60 mins * 60 secs * 1000 ms)
    let since = exchange.milliseconds() - (overallCandleTarget * 3 * 60 * 60 * 1000); 

    console.log(`🚀 No cache found. Fetching 3H matrix data over ${PROXY_POOL.length} proxies...`);

    for (let i = 0; i < PROXY_POOL.length; i++) {
        activeImpersonator = new Impit({ browser: 'chrome', proxyUrl: PROXY_POOL[i] });
        let proxyFetchedCount = 0;
        
        while (proxyFetchedCount < 5000) {
            try {
                const batch = await exchange.fetchOHLCV('SOL/USDT', '3h', since, 1000);
                if (!batch || batch.length === 0) break;
                
                allCandles = allCandles.concat(batch);
                proxyFetchedCount += batch.length;
                since = batch[batch.length - 1][0] + 1; 
                
                console.log(`📥 Fetched ${batch.length} candles (Total: ${allCandles.length}) via Proxy ${i + 1}`);

                if (batch.length < 1000) break; // We've reached current time
                await new Promise(r => setTimeout(r, 1100)); // Respect rate limits
            } catch (e) {
                console.log(`⚠️ Proxy ${i + 1} hit an error or limit: ${e.message}`);
                break; 
            }
        }
        if (since > exchange.milliseconds()) break; // Stop if we've caught up to the present
    }

    if (allCandles.length < 50) {
        console.log("❌ Matrix initialization failed. Not enough data.");
        return [];
    }

    // 3. Save the fetched data to the cache file
    console.log(`💾 Saving ${allCandles.length} candles to ${CACHE_FILENAME}...`);
    fs.writeFileSync(CACHE_FILENAME, JSON.stringify(allCandles));
    console.log("✅ Data successfully cached and ready for backtesting!");

    return allCandles;
}

// Start the engine
async function start() {
    const data = await runBacktest();
    if (data.length > 0) {
        console.log(`\nReady to run strategy on ${data.length} total 3H candles.`);
    }
}

start();