// backtester_2.js - CEX Edition (Backtest + Live Paper Trading)
const ccxt = require('ccxt');
const { Impit } = require('impit');
const http = require('http'); 

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

const settings = {
    ema_fast_period: 5, ema_slow_period: 13,
    macro_ema_fast: 27, macro_ema_slow: 63,
    base_confidence: 50.1 
};

// --- CEX Risk & Fee Mechanics (Derivatives Tier: Intro 1) ---
const riskSettings = {
    atrStopMultiplier: 1.5,       
    atrActivationMultiplier: 4.0, 
    atrTrailMultiplier: 1.0,      
    slippagePerc: 0.0005,         
    takerFeePerc: 0.001,   // Updated: 0.100% Market Entry (Derivatives)
    makerFeePerc: 0.00095  // Updated: 0.095% Stop/Limit Exit (Derivatives)
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

// Core Engine Simulator
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
    
    const rawATR = trSum / 14; 
    const atrPercentage = (rawATR / currentClose) * 100;

    const isMacroUp = macroEmaFast > macroEmaSlow;
    const isMacroDown = macroEmaFast < macroEmaSlow;
    const microTrendUp = emaFast > emaSlow;
    const microTrendDown = emaFast < emaSlow;

    let pred = "SKIP";
    let strategyTriggered = "";

    const pullbackUp = isMacroUp && microTrendUp && rsi > 30 && rsi < 58 && currentHist > prevHist;
    const pullbackDown = isMacroDown && microTrendDown && rsi < 70 && rsi > 42 && currentHist < prevHist;

    const breakoutUp = isMacroUp && microTrendUp && rvol > 1.3 && currentHist > 0 && currentHist > prevHist && currentClose > currentOpen;
    const breakoutDown = isMacroDown && microTrendDown && rvol > 1.3 && currentHist < 0 && currentHist < prevHist && currentClose < currentOpen;

    if (pullbackUp || breakoutUp) {
        pred = "UP";
        strategyTriggered = breakoutUp ? "BREAKOUT" : "PULLBACK";
    } else if (pullbackDown || breakoutDown) {
        pred = "DOWN";
        strategyTriggered = breakoutDown ? "BREAKOUT" : "PULLBACK";
    }

    if (isWhipsaw && strategyTriggered === "PULLBACK") return { pred: "SKIP", conf: 0, atr: rawATR };           
    if (atrPercentage < 0.04) return { pred: "SKIP", conf: 0, atr: rawATR }; 

    let conf = 48.0; 
    if (isMacroUp && microTrendUp && pred === "UP") conf += 1.5;
    if (isMacroDown && microTrendDown && pred === "DOWN") conf += 1.5;
    if (pred === "UP" && lowerWick > (bodySize * 0.7)) conf += 2.0;
    if (pred === "DOWN" && upperWick > (bodySize * 0.7)) conf += 2.0;
    if (strategyTriggered === "BREAKOUT" && rvol > 1.6) conf += 3.5; 
    if (atrPercentage > 0.20) conf -= 5.0; 

    if (conf < settings.base_confidence) return { pred: "SKIP", conf, atr: rawATR };

    return { pred, conf, atr: rawATR };
}

// ------------------------------------------------------------------
// CORE ARCHITECTURE: FETCHERS & EXCHANGE INIT
// ------------------------------------------------------------------
let activeImpersonator = null;

const safeFetch = async (url, options = {}) => {
    if (!activeImpersonator) return new Response(JSON.stringify({ error: "No proxy" }), { status: 500 });
    try {
        options.headers = options.headers || {};
        Object.assign(options.headers, {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json, text/plain, */*'
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

// ------------------------------------------------------------------
// MODULE 1: HISTORICAL BACKTEST (FEE ADJUSTED)
// ------------------------------------------------------------------
async function runBacktest() {
    let allCandles = [];
    const overallCandleTarget = PROXY_POOL.length * 5000;
    let since = exchange.milliseconds() - (overallCandleTarget * 5 * 60 * 1000); 

    console.log(`🚀 Starting execution over ${PROXY_POOL.length} proxies...`);

    for (let i = 0; i < PROXY_POOL.length; i++) {
        activeImpersonator = new Impit({ browser: 'chrome', proxyUrl: PROXY_POOL[i] });
        let proxyFetchedCount = 0;
        
        while (proxyFetchedCount < 5000) {
            try {
                const batch = await exchange.fetchOHLCV('ETH/USDT', '5m', since, 1000);
                if (!batch || batch.length === 0) break;
                
                allCandles = allCandles.concat(batch);
                proxyFetchedCount += batch.length;
                since = batch[batch.length - 1][0] + 1; 
                
                if (batch.length < 1000) break;
                await new Promise(r => setTimeout(r, 1100));
            } catch (e) {
                break; 
            }
        }
        if (since > exchange.milliseconds()) break; 
    }

    if (allCandles.length < 50) return console.log("❌ Matrix initialization failed.");

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
                    if (high > position.highWaterMark) {
                        position.highWaterMark = high;
                        if (position.highWaterMark >= position.activationPrice) {
                            const newSL = position.highWaterMark - position.trailAmount;
                            if (newSL > position.sl) position.sl = newSL; 
                        }
                    }
                    if (low <= position.sl) {
                        exitPrice = position.sl;
                        tradeClosed = true;
                    }
                } 
                else if (position.type === 'DOWN') {
                    if (low < position.lowWaterMark) {
                        position.lowWaterMark = low;
                        if (position.lowWaterMark <= position.activationPrice) {
                            const newSL = position.lowWaterMark + position.trailAmount;
                            if (newSL < position.sl) position.sl = newSL; 
                        }
                    }
                    if (high >= position.sl) {
                        exitPrice = position.sl;
                        tradeClosed = true;
                    }
                }

                if (tradeClosed) {
                    // CEX FEE DEDUCTION LOGIC
                    const entryFee = position.entry * riskSettings.takerFeePerc;
                    const exitFee = exitPrice * riskSettings.makerFeePerc;
                    const grossPnL = position.type === 'UP' ? (exitPrice - position.entry) : (position.entry - exitPrice);
                    const netPnL = grossPnL - (entryFee + exitFee);

                    if (netPnL > 0) wins++;
                    else if (netPnL < 0) losses++;
                    else breakevens++;

                    position = null; 
                }
                continue; 
            }

            const historicalSlice = dataArray.slice(i - 200, i);
            const { pred, atr } = simulatePrediction(historicalSlice);
            
            if (pred === "SKIP") skips++;
            else if (pred === "UP") {
                const entryPrice = close * (1 + riskSettings.slippagePerc);
                position = {
                    type: 'UP', entry: entryPrice, sl: entryPrice - (atr * riskSettings.atrStopMultiplier),
                    highWaterMark: entryPrice, activationPrice: entryPrice + (atr * riskSettings.atrActivationMultiplier),
                    trailAmount: (atr * riskSettings.atrTrailMultiplier)
                };
            } else if (pred === "DOWN") {
                const entryPrice = close * (1 - riskSettings.slippagePerc);
                position = {
                    type: 'DOWN', entry: entryPrice, sl: entryPrice + (atr * riskSettings.atrStopMultiplier),
                    lowWaterMark: entryPrice, activationPrice: entryPrice - (atr * riskSettings.atrActivationMultiplier),
                    trailAmount: (atr * riskSettings.atrTrailMultiplier)
                };
            }
        }

        const totalTrades = wins + losses + breakevens;
        const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0;
        
        console.log(`\n📊 --- ${phaseName} (NET CEX FEES) ---`);
        console.log(`Total Executed: ${totalTrades} | Wins: ${wins} | Losses: ${losses} | Skipped: ${skips}`);
        console.log(`Net Profitable Win Rate: ${winRate}%`);
    };

    testPhase(inSample, "IN-SAMPLE");
    testPhase(outOfSample, "OUT-OF-SAMPLE");
}

// ------------------------------------------------------------------
// MODULE 2: LIVE PAPER TRADING ENGINE
// ------------------------------------------------------------------
let livePosition = null;

async function startPaperTrading() {
    console.log(`\n🟢 Transitioning to Live Paper Trading Engine. Monitoring ETH/USDT...`);
    activeImpersonator = new Impit({ browser: 'chrome', proxyUrl: PROXY_POOL[0] }); // Just use proxy 1 for live polling

    setInterval(async () => {
        try {
            // Fetch last 200 candles to feed the indicators
            const recentCandles = await exchange.fetchOHLCV('ETH/USDT', '5m', undefined, 200);
            const latestClose = recentCandles[recentCandles.length - 1][4];
            
            // --- Position Management ---
            if (livePosition) {
                let tradeClosed = false;
                const high = recentCandles[recentCandles.length - 1][2];
                const low = recentCandles[recentCandles.length - 1][3];

                if (livePosition.type === 'UP') {
                    if (high > livePosition.highWaterMark) {
                        livePosition.highWaterMark = high;
                        if (livePosition.highWaterMark >= livePosition.activationPrice) {
                            const newSL = livePosition.highWaterMark - livePosition.trailAmount;
                            if (newSL > livePosition.sl) livePosition.sl = newSL;
                        }
                    }
                    if (low <= livePosition.sl) tradeClosed = true;
                } else if (livePosition.type === 'DOWN') {
                    if (low < livePosition.lowWaterMark) {
                        livePosition.lowWaterMark = low;
                        if (livePosition.lowWaterMark <= livePosition.activationPrice) {
                            const newSL = livePosition.lowWaterMark + livePosition.trailAmount;
                            if (newSL < livePosition.sl) livePosition.sl = newSL;
                        }
                    }
                    if (high >= livePosition.sl) tradeClosed = true;
                }

                if (tradeClosed) {
                    const exitPrice = livePosition.sl;
                    const entryFee = livePosition.entry * riskSettings.takerFeePerc;
                    const exitFee = exitPrice * riskSettings.makerFeePerc;
                    const grossPnL = livePosition.type === 'UP' ? (exitPrice - livePosition.entry) : (livePosition.entry - exitPrice);
                    const netPnL = grossPnL - (entryFee + exitFee);

                    console.log(JSON.stringify({
                        event: "TRADE_CLOSED",
                        type: livePosition.type,
                        entry: livePosition.entry,
                        exit: exitPrice,
                        netPnL: netPnL,
                        timestamp: new Date().toISOString()
                    }));
                    livePosition = null;
                }
                return; // Wait for next tick if in trade
            }

            // --- Signal Generation ---
            const { pred, conf, atr } = simulatePrediction(recentCandles);
            
            if (pred === "UP") {
                const entryPrice = latestClose * (1 + riskSettings.slippagePerc);
                livePosition = {
                    type: 'UP', entry: entryPrice, sl: entryPrice - (atr * riskSettings.atrStopMultiplier),
                    highWaterMark: entryPrice, activationPrice: entryPrice + (atr * riskSettings.atrActivationMultiplier),
                    trailAmount: (atr * riskSettings.atrTrailMultiplier)
                };
                console.log(JSON.stringify({ event: "TRADE_OPENED", type: "UP", price: entryPrice, conf: conf, timestamp: new Date().toISOString() }));
            } 
            else if (pred === "DOWN") {
                const entryPrice = latestClose * (1 - riskSettings.slippagePerc);
                livePosition = {
                    type: 'DOWN', entry: entryPrice, sl: entryPrice + (atr * riskSettings.atrStopMultiplier),
                    lowWaterMark: entryPrice, activationPrice: entryPrice - (atr * riskSettings.atrActivationMultiplier),
                    trailAmount: (atr * riskSettings.atrTrailMultiplier)
                };
                console.log(JSON.stringify({ event: "TRADE_OPENED", type: "DOWN", price: entryPrice, conf: conf, timestamp: new Date().toISOString() }));
            }

        } catch (err) {
            console.error(`Paper Trading Fetch Error: ${err.message}`);
        }
    }, 300000); // 300,000 ms = 5 minutes
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CEX Engine Online!\n');
}).listen(PORT, '0.0.0.0', async () => {
    console.log(`🟢 Server bound to port ${PORT}.`);
    await runBacktest();
    startPaperTrading();
});
