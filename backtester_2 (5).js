// backtester_2.js - True Historical Forward/Backtester (Web Service Edition)
const ccxt = require('ccxt');
const { Impit } = require('impit');
const http = require('http'); 

// --- 🌐 PROXY CONFIGURATION POOL ---
// Replace placeholders with your actual Webshare (or other) credentials
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
    'http://zirrujpi-ch-532854:8e2wprq017db@p.webshare.io:80'                             // Proxy 10
];

// Your static weights from Supabase
const settings = {
    ema_fast_period: 5, ema_slow_period: 13,
    macro_ema_fast: 27, macro_ema_slow: 63,
    weight_macd: 3.0, weight_rsi: 1.5, weight_ema: 2.0, 
    weight_pattern: 2.5, weight_history: 1.0, macro_weight: 1.5,
    penalty_3_candles: 2.0, penalty_4_candles: 3.0, penalty_5_candles: 10.0,
    rvol_threshold: 1.5, volatility_threshold: 0.14,
    base_confidence: 50.1, 
    high_volatility_confidence: 50.1 
};

// --- Dynamic ATR & Trailing Stop Mechanics ---
const riskSettings = {
    atrStopMultiplier: 1.5,       // Initial SL is 1.5x the current ATR
    atrActivationMultiplier: 1.0, // Start trailing once in profit by 1.0x ATR
    atrTrailMultiplier: 1.0,      // Trail behind the highest price by 1.0x ATR
    slippagePerc: 0.0005          // 0.05% assumed entry slippage 
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

// Optimized Core Engine Simulator - Dual Strategy (High Frequency) Edition
function simulatePrediction(candles) {
    if (candles.length < 200) return { pred: "SKIP", conf: 0, atr: 0 };

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

    // Filter absolute dead chop
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
    
    // Extracted raw ATR dollar value for stop-loss calculations
    const rawATR = trSum / 14; 
    const atrPercentage = (rawATR / currentClose) * 100;

    const isMacroUp = macroEmaFast > macroEmaSlow;
    const isMacroDown = macroEmaFast < macroEmaSlow;
    const microTrendUp = emaFast > emaSlow;
    const microTrendDown = emaFast < emaSlow;

    let pred = "SKIP";
    let strategyTriggered = "";

    // ==========================================
    // STRATEGY A: THE PULLBACK SNIPER (Widened RSI Net)
    // ==========================================
    const pullbackUp = isMacroUp && microTrendUp && rsi > 30 && rsi < 58 && currentHist > prevHist;
    const pullbackDown = isMacroDown && microTrendDown && rsi < 70 && rsi > 42 && currentHist < prevHist;

    // ==========================================
    // STRATEGY B: THE MOMENTUM BREAKOUT (Added Macro Alignment)
    // ==========================================
    const breakoutUp = isMacroUp && microTrendUp && rvol > 1.3 && currentHist > 0 && currentHist > prevHist && currentClose > currentOpen;
    const breakoutDown = isMacroDown && microTrendDown && rvol > 1.3 && currentHist < 0 && currentHist < prevHist && currentClose < currentOpen;

    // --- EVALUATE TRIGGERS ---
    if (pullbackUp || breakoutUp) {
        pred = "UP";
        strategyTriggered = breakoutUp ? "BREAKOUT" : "PULLBACK";
    } else if (pullbackDown || breakoutDown) {
        pred = "DOWN";
        strategyTriggered = breakoutDown ? "BREAKOUT" : "PULLBACK";
    }

    // --- 🛡️ BARE MINIMUM VETO SYSTEMS ---
    let isVetoed = false;
    
    // Only veto Whipsaw if we are trying to trade a pullback.
    if (isWhipsaw && strategyTriggered === "PULLBACK") isVetoed = true;            
    
    // Avoid absolutely dead markets
    if (atrPercentage < 0.04) isVetoed = true; 

    if (isVetoed) return { pred: "SKIP", conf: 0, atr: rawATR };

    // --- 📊 DYNAMIC CONFIDENCE SCORING ---
    let conf = 48.0; 
    
    // 1. Reward perfect dual-trend alignment
    if (isMacroUp && microTrendUp && pred === "UP") conf += 1.5;
    if (isMacroDown && microTrendDown && pred === "DOWN") conf += 1.5;

    // 2. Reward Price Action (Relaxed Wick Logic to catch more plays)
    if (pred === "UP" && lowerWick > (bodySize * 0.7)) conf += 2.0;
    if (pred === "DOWN" && upperWick > (bodySize * 0.7)) conf += 2.0;

    // 3. Reward Volume (Slightly easier threshold for breakout validation)
    if (strategyTriggered === "BREAKOUT" && rvol > 1.6) conf += 3.5; 
    
    // Penalize if volatility is so insane it will knock out your SL via spread
    if (atrPercentage > 0.20) conf -= 5.0; 

    if (conf < settings.base_confidence) return { pred: "SKIP", conf, atr: rawATR };

    return { pred, conf, atr: rawATR };
}

async function runBacktest() {
    // Shared reference updated during proxy rotation loops
    let activeImpersonator = null;

    // --- 🛡️ THE FIX: DYNAMIC ROTATING FETCH WRAPPER ---
    const safeFetch = async (url, options = {}) => {
        if (!activeImpersonator) {
            return new Response(JSON.stringify({ error: "No active proxy session configured." }), { status: 500 });
        }
        try {
            options.headers = options.headers || {};
            Object.assign(options.headers, {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-site'
            });
            return await activeImpersonator.fetch(url, options);
        } catch (err) {
            console.log(`⚠️ Proxy connection issue handled: ${err.message}`);
            return new Response(JSON.stringify({ error: err.message }), { 
                status: 502, 
                statusText: "Bad Gateway - Proxy Rotator Intercept" 
            });
        }
    };
    
    class DummyFetchError extends Error {}
    safeFetch.FetchError = DummyFetchError;
    safeFetch.Headers = globalThis.Headers || Map;
    safeFetch.Request = globalThis.Request || Object;
    safeFetch.Response = globalThis.Response || Object;

    // Instantiating standard CCXT Binance client with our custom dynamic fetcher
    const exchange = new ccxt.binance({
        fetchImplementation: safeFetch,
        enableRateLimit: true 
    });
    
    let allCandles = [];
    
    // Calculate full lookback required (10 proxies * 5000 candles = 50,000 candles back)
    const overallCandleTarget = PROXY_POOL.length * 5000;
    let since = exchange.milliseconds() - (overallCandleTarget * 5 * 60 * 1000); 

    console.log(`🚀 Starting execution over ${PROXY_POOL.length} configured proxies. Target: ${overallCandleTarget} candles...`);

    // --- 🔄 ROTATION LOOP ---
    for (let i = 0; i < PROXY_POOL.length; i++) {
        const currentProxyUrl = PROXY_POOL[i];
        const proxyLabel = currentProxyUrl.includes('@') ? currentProxyUrl.split('@')[1] : currentProxyUrl;
        
        console.log(`\n⚙️ [Proxy ${i + 1}/${PROXY_POOL.length}] Connecting to tunnel via: ${proxyLabel}`);
        
        activeImpersonator = new Impit({ 
            browser: 'chrome',
            proxyUrl: currentProxyUrl 
        });

        // Verify routing IP
        try {
            const res = await activeImpersonator.fetch('https://api.ipify.org?format=json');
            if (!res.ok) throw new Error(`Status ${res.status}`);
            const ipData = await res.json();
            console.log(`✅ Connection confirmed. Exit IP: ${ipData.ip}`);
        } catch (err) {
            console.error(`❌ Proxy ${i + 1} validation failed (${err.message}). Advancing to next available proxy.`);
            continue; 
        }

        let proxyFetchedCount = 0;
        
        // Pull 5000 candles with current proxy in 1000-candle increments
        while (proxyFetchedCount < 5000) {
            try {
                // Requesting maximum permitted candle block size allowed by Binance (1000 candles)
                const batch = await exchange.fetchOHLCV('ETH/USDT', '5m', since, 1000);
                
                if (!batch || batch.length === 0) {
                    console.log("ℹ️ No further historical candles exposed by endpoint.");
                    break;
                }
                
                allCandles = allCandles.concat(batch);
                proxyFetchedCount += batch.length;
                since = batch[batch.length - 1][0] + 1; // Update pagination pointer
                
                console.log(`   📥 Extracted batch of ${batch.length} candles. (Proxy Progress: ${proxyFetchedCount}/5000 | Dataset Total: ${allCandles.length})`);
                
                if (batch.length < 1000) {
                    console.log("ℹ️ Reached current real-time data timeline.");
                    break;
                }
                
                // Keep rate limits clean
                await new Promise(r => setTimeout(r, 1100));
            } catch (e) {
                console.log(`⚠️ Execution Exception experienced on Proxy ${i + 1}:`, e.message);
                break; // Escape inner loop to trigger fallback to next proxy pool asset
            }
        }
        
        if (since > exchange.milliseconds()) break; 
    }

    if (allCandles.length < 50) {
        console.log("❌ Matrix initialization failed. Insufficient dataset depth to construct backtest state engines.");
        return;
    }

    console.log(`\n🎉 Success! Combined a aggregate historical dataset of ${allCandles.length} candles.`);

    const splitIndex = Math.floor(allCandles.length * 0.7);
    const inSample = allCandles.slice(0, splitIndex);
    const outOfSample = allCandles.slice(splitIndex);

    const testPhase = (dataArray, phaseName) => {
        let wins = 0, losses = 0, breakevens = 0, skips = 0;
        let position = null; 
        
        for (let i = 200; i < dataArray.length - 1; i++) { 
            const currentCandle = dataArray[i];
            const high = currentCandle[2];
            const low = currentCandle[3];
            const close = currentCandle[4];

            if (position) {
                let tradeClosed = false;
                let exitPrice = 0;

                if (position.type === 'UP') {
                    // 1. Update Highest Water Mark
                    if (high > position.highWaterMark) {
                        position.highWaterMark = high;
                        
                        // 2. Check if we reached activation threshold to start trailing
                        if (position.highWaterMark >= position.activationPrice) {
                            const newSL = position.highWaterMark - position.trailAmount;
                            // Only move the stop loss UP, never down
                            if (newSL > position.sl) position.sl = newSL; 
                        }
                    }

                    // 3. Did we hit the Stop Loss? (Backtesting assumes worst-case intra-candle movement)
                    if (low <= position.sl) {
                        exitPrice = position.sl;
                        tradeClosed = true;
                    }
                } 
                else if (position.type === 'DOWN') {
                    // 1. Update Lowest Water Mark (Short logic)
                    if (low < position.lowWaterMark) {
                        position.lowWaterMark = low;
                        
                        if (position.lowWaterMark <= position.activationPrice) {
                            const newSL = position.lowWaterMark + position.trailAmount;
                            if (newSL < position.sl) position.sl = newSL; 
                        }
                    }

                    // 3. Did we hit the Stop Loss?
                    if (high >= position.sl) {
                        exitPrice = position.sl;
                        tradeClosed = true;
                    }
                }

                if (tradeClosed) {
                    // Determine PnL based on entry vs dynamic exit price
                    const pnl = position.type === 'UP' 
                        ? (exitPrice - position.entry) 
                        : (position.entry - exitPrice);

                    if (pnl > 0) wins++;
                    else if (pnl < 0) losses++;
                    else breakevens++;

                    position = null; 
                }
                continue; 
            }

            const historicalSlice = dataArray.slice(i - 200, i);
            const { pred, atr } = simulatePrediction(historicalSlice);
            
            if (pred === "SKIP") {
                skips++;
            } else if (pred === "UP") {
                const entryPrice = close * (1 + riskSettings.slippagePerc);
                position = {
                    type: 'UP',
                    entry: entryPrice,
                    sl: entryPrice - (atr * riskSettings.atrStopMultiplier),
                    highWaterMark: entryPrice,
                    activationPrice: entryPrice + (atr * riskSettings.atrActivationMultiplier),
                    trailAmount: (atr * riskSettings.atrTrailMultiplier)
                };
            } else if (pred === "DOWN") {
                const entryPrice = close * (1 - riskSettings.slippagePerc);
                position = {
                    type: 'DOWN',
                    entry: entryPrice,
                    sl: entryPrice + (atr * riskSettings.atrStopMultiplier),
                    lowWaterMark: entryPrice,
                    activationPrice: entryPrice - (atr * riskSettings.atrActivationMultiplier),
                    trailAmount: (atr * riskSettings.atrTrailMultiplier)
                };
            }
        }

        const totalTrades = wins + losses + breakevens;
        const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0;
        
        console.log(`\n📊 --- ${phaseName} RESULTS ---`);
        console.log(`Total Trades Executed: ${totalTrades}`);
        console.log(`Wins: ${wins} | Losses: ${losses} | Breakevens: ${breakevens} | Skipped: ${skips}`);
        console.log(`Win Rate (Profitable Trades): ${winRate}%`);
    };

    testPhase(inSample, "IN-SAMPLE (Sandbox Phase)");
    testPhase(outOfSample, "OUT-OF-SAMPLE (Lie Detector Phase)");
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Binance Data / Crypto.com UpDown Simulator is online! View Render runtime logs for metrics output.\n');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🟢 Dummy web server bound to port ${PORT} on 0.0.0.0. Render Health Checks will pass!`);
    runBacktest().catch(console.error);
});
