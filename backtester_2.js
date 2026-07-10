// backtester_2.js - True Historical Forward/Backtester (Binary Epoch Edition)
const ccxt = require('ccxt');
const { Impit } = require('impit');
const http = require('http'); 

// --- 🌐 PROXY CONFIGURATION POOL ---
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

// Your static weights from Supabase
const settings = {
    ema_fast_period: 5, ema_slow_period: 13,
    macro_ema_fast: 27, macro_ema_slow: 63,
    base_confidence: 50.1
};

// --- Polymarket / PancakeSwap Epoch Mechanics ---
const predictionSettings = {
    epochDurationCandles: 1,  // 1 Candle = 5 Minutes
    slippagePerc: 0.0005      // 0.05% buffer to account for pool spread/fees
};

// Math Helpers
const calculateEMAArray = (data, period) => {
    const k = 2 / (period + 1);
    let emaArray = [data[0]];
    for (let i = 1; i < data.length; i++) {
        emaArray.push((data[i] * k) + (emaArray[i - 1] * (1 - k)));
    }
    return emaArray;
};

const calculateRSI = (closes) => {
    let gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
        let diff = closes[i] - closes[i - 1];
        gains.push(diff > 0 ? diff : 0);
        losses.push(diff < 0 ? Math.abs(diff) : 0);
    }
    let avgGain = gains.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
    let avgLoss = losses.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
    let rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
    for (let i = 14; i < gains.length; i++) {
        avgGain = ((avgGain * 13) + gains[i]) / 14;
        avgLoss = ((avgLoss * 13) + losses[i]) / 14;
        rsi = avgLoss === 0 ? 100 : (avgGain === 0 ? 0 : 100 - (100 / (1 + (avgGain / avgLoss))));
    }
    return rsi;
};

// Optimized Core Engine Simulator - 5-Min Binary Prediction Edition
function simulatePrediction(candles) {
    if (candles.length < 200) return { pred: "SKIP", conf: 0 };

    const opens = candles.map(c => parseFloat(c[1]));
    const highs = candles.map(c => parseFloat(c[2]));
    const lows = candles.map(c => parseFloat(c[3]));
    const closes = candles.map(c => parseFloat(c[4]));
    const volumes = candles.map(c => parseFloat(c[5]));

    const idx = closes.length - 1; 
    const currentClose = closes[idx];
    const currentOpen = opens[idx];
    const currentHigh = highs[idx];
    const currentLow = lows[idx];

    const rsi = calculateRSI(closes);
    
    const emaFast = calculateEMAArray(closes, settings.ema_fast_period).pop();
    const emaSlow = calculateEMAArray(closes, settings.ema_slow_period).pop();
    const macroEmaFast = calculateEMAArray(closes, settings.macro_ema_fast).pop();
    const macroEmaSlow = calculateEMAArray(closes, settings.macro_ema_slow).pop();
    
    const ema12 = calculateEMAArray(closes, 12);
    const ema26 = calculateEMAArray(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signalLine = calculateEMAArray(macdLine, 9);
    
    const currentHist = macdLine[idx] - signalLine[idx];
    const prevHist = macdLine[idx - 1] - signalLine[idx - 1];

    const volSMA20 = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const rvol = volumes[idx] / volSMA20;

    const upperWick = currentHigh - Math.max(currentOpen, currentClose);
    const lowerWick = Math.min(currentOpen, currentClose) - currentLow;
    const bodySize = Math.max(Math.abs(currentClose - currentOpen), 0.0001);

    // Veto chop
    let colorFlips = 0;
    for (let i = closes.length - 1; i >= closes.length - 4; i--) {
        const currentColor = closes[i] >= opens[i] ? 'green' : 'red';
        const prevColor = closes[i-1] >= opens[i-1] ? 'green' : 'red';
        if (currentColor !== prevColor) colorFlips++;
    }
    const isWhipsaw = colorFlips >= 3;

    let trSum = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
        const highLow = highs[i] - lows[i];
        const highClose = Math.abs(highs[i] - closes[i-1]);
        const lowClose = Math.abs(lows[i] - closes[i-1]);
        trSum += Math.max(highLow, highClose, lowClose);
    }
    const atrPercentage = ((trSum / 14) / currentClose) * 100;

    const isMacroUp = macroEmaFast > macroEmaSlow;
    const isMacroDown = macroEmaFast < macroEmaSlow;
    const microTrendUp = emaFast > emaSlow;
    const microTrendDown = emaFast < emaSlow;

    let pred = "SKIP";

    // ==========================================
    // BINARY STRATEGY: MOMENTUM CONTINUATION
    // For a 5-min epoch, we need aggressive momentum to guarantee the next candle pushes further
    // ==========================================
    
    // UP Condition: Macro is Up, Micro is Up, Volume is surging, MACD is accelerating upwards
    const momentumUp = isMacroUp && microTrendUp && rvol > 1.2 && currentHist > 0 && currentHist > prevHist && currentClose > currentOpen;
    
    // DOWN Condition: Macro is Down, Micro is Down, Volume is surging, MACD is accelerating downwards
    const momentumDown = isMacroDown && microTrendDown && rvol > 1.2 && currentHist < 0 && currentHist < prevHist && currentClose < currentOpen;

    if (momentumUp) pred = "UP";
    else if (momentumDown) pred = "DOWN";

    // --- 🛡️ VETOS ---
    if (isWhipsaw || atrPercentage < 0.04) return { pred: "SKIP", conf: 0 };

    // --- 📊 DYNAMIC CONFIDENCE SCORING ---
    let conf = 48.0; 
    
    if (pred === "UP") {
        if (lowerWick > (bodySize * 0.5)) conf += 2.0; // Bullish rejection
        if (rsi > 55 && rsi < 75) conf += 1.5;         // Perfect momentum zone
    } 
    else if (pred === "DOWN") {
        if (upperWick > (bodySize * 0.5)) conf += 2.0; // Bearish rejection
        if (rsi < 45 && rsi > 25) conf += 1.5;         // Perfect momentum zone
    }

    if (rvol > 1.8) conf += 2.0; // High volume practically guarantees continuation
    
    if (conf < settings.base_confidence) return { pred: "SKIP", conf };

    return { pred, conf };
}

async function runBacktest() {
    let activeImpersonator = null;

    const safeFetch = async (url, options = {}) => {
        if (!activeImpersonator) return new Response(JSON.stringify({ error: "No proxy" }), { status: 500 });
        try {
            options.headers = options.headers || {};
            Object.assign(options.headers, {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-site'
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
        enableRateLimit: true 
    });
    
    let allCandles = [];
    const overallCandleTarget = PROXY_POOL.length * 5000;
    let since = exchange.milliseconds() - (overallCandleTarget * 5 * 60 * 1000); 

    console.log(`🚀 Starting execution over ${PROXY_POOL.length} proxies for Epoch Simulation...`);

    for (let i = 0; i < PROXY_POOL.length; i++) {
        const currentProxyUrl = PROXY_POOL[i];
        
        activeImpersonator = new Impit({ 
            browser: 'chrome',
            proxyUrl: currentProxyUrl 
        });

        try {
            const res = await activeImpersonator.fetch('https://api.ipify.org?format=json');
            if (!res.ok) throw new Error(`Status ${res.status}`);
        } catch (err) {
            console.error(`❌ Proxy ${i + 1} validation failed. Skipping.`);
            continue; 
        }

        let proxyFetchedCount = 0;
        
        while (proxyFetchedCount < 5000) {
            try {
                const batch = await exchange.fetchOHLCV('ETH/USDT', '5m', since, 1000);
                if (!batch || batch.length === 0) break;
                
                allCandles = allCandles.concat(batch);
                proxyFetchedCount += batch.length;
                since = batch[batch.length - 1][0] + 1; 
                
                console.log(`   📥 Extracted batch of ${batch.length} candles. Dataset Total: ${allCandles.length}`);
                
                if (batch.length < 1000) break;
                await new Promise(r => setTimeout(r, 1100));
            } catch (e) {
                break; 
            }
        }
        if (since > exchange.milliseconds()) break; 
    }

    if (allCandles.length < 50) {
        console.log("❌ Matrix initialization failed. Insufficient dataset depth.");
        return;
    }

    console.log(`\n🎉 Success! Combined an aggregate dataset of ${allCandles.length} candles.`);

    const splitIndex = Math.floor(allCandles.length * 0.7);
    const inSample = allCandles.slice(0, splitIndex);
    const outOfSample = allCandles.slice(splitIndex);

    // --- NEW BINARY EPOCH TEST PHASE ---
    const testPhase = (dataArray, phaseName) => {
        let wins = 0, losses = 0, skips = 0;
        
        // We stop looping early enough so we have the future candle available to check the result
        for (let i = 200; i < dataArray.length - predictionSettings.epochDurationCandles; i++) { 
            const currentCandle = dataArray[i];
            const currentClose = currentCandle[4];

            const historicalSlice = dataArray.slice(i - 200, i + 1); // Pass history UP TO current candle
            const { pred } = simulatePrediction(historicalSlice);
            
            if (pred === "SKIP") {
                skips++;
                continue;
            }

            // The prediction market resolves EXACTLY N candles later
            const resolutionCandle = dataArray[i + predictionSettings.epochDurationCandles];
            const resolutionClose = resolutionCandle[4];

            if (pred === "UP") {
                const entryPrice = currentClose * (1 + predictionSettings.slippagePerc);
                if (resolutionClose > entryPrice) wins++;
                else losses++;
            } else if (pred === "DOWN") {
                const entryPrice = currentClose * (1 - predictionSettings.slippagePerc);
                if (resolutionClose < entryPrice) wins++;
                else losses++;
            }
        }

        const totalTrades = wins + losses;
        const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0;
        
        console.log(`\n📊 --- ${phaseName} RESULTS (5-MIN EPOCH RESOLUTION) ---`);
        console.log(`Total Trades Executed: ${totalTrades}`);
        console.log(`Wins: ${wins} | Losses: ${losses} | Skipped: ${skips}`);
        console.log(`Prediction Win Rate: ${winRate}%`);
    };

    testPhase(inSample, "IN-SAMPLE (Sandbox Phase)");
    testPhase(outOfSample, "OUT-OF-SAMPLE (Lie Detector Phase)");
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Prediction Market Simulator is online! View Render runtime logs for metrics output.\n');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🟢 Dummy web server bound to port ${PORT} on 0.0.0.0. Render Health Checks will pass!`);
    runBacktest().catch(console.error);
});
