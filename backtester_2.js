// backtester_2.js - The Binary Hold Edition (CEX Derivatives) - 3H TIMEFRAME
const ccxt = require('ccxt');
const { Impit } = require('impit');
const http = require('http'); 
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

// ─── INSTITUTIONAL TREND CONFIGURATION (3H ADAPTED) ───────────
const settings = {
    ema_fast_period: 9,      
    ema_slow_period: 21,     
    macro_ema_fast: 50,      
    macro_ema_slow: 200,
    htf_macro_ema: 67,   
    min_confidence: 48    // Raised from 57 to demand higher conviction and dodge chop
};

const tradeSettings = {
    contractSize: 5,       
    amountContracts: 0.1,
    leverage: 10,
    cooldownCandles: 1   
};

// ─── ASYMMETRICAL RISK BRACKET (1:1.5 R:R) ─────────────────────
const riskSettings = {
    atrStopMultiplier: 3.0,   // Tightened stop to cut losses earlier
    atrProfitMultiplier: 4.5, // Expanded target to outpace fee/slippage drag
    slippagePerc: 0.0005,         
    takerFeePerc: 0.001,   
    makerFeePerc: 0.00095
};

// Math Helpers
const calculateEMAArray = (data, period) => {
    if (data.length < period) return [];
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
    if (candles.length < 850) return { pred: "SKIP", intent: "NONE", conf: 0, atr: 0 };

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
    const htfEma = calculateEMAArray(closes, settings.htf_macro_ema).pop(); 
    
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

    // Current Volatility (ATR)
    let trSum = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
        const highLow = highs[i] - lows[i];
        const highClose = Math.abs(highs[i] - closes[i-1]);
        const lowClose = Math.abs(lows[i] - closes[i-1]);
        trSum += Math.max(highLow, highClose, lowClose);
    }
    const rawATR = trSum / 14; 
    const atrPercentage = (rawATR / currentClose) * 100;

    // Previous Volatility (ATR Expansion Check)
    let prevTrSum = 0;
    for (let i = closes.length - 15; i < closes.length - 1; i++) {
        const highLow = highs[i] - lows[i];
        const highClose = Math.abs(highs[i] - closes[i-1]);
        const lowClose = Math.abs(lows[i] - closes[i-1]);
        prevTrSum += Math.max(highLow, highClose, lowClose);
    }
    const prevATR = prevTrSum / 14;
    const isExpanding = rawATR > prevATR;

    // Perfect Structural Fanning
    const isBullFan = emaFast > emaSlow && emaSlow > macroEmaFast && macroEmaFast > macroEmaSlow;
    const isBearFan = emaFast < emaSlow && emaSlow < macroEmaFast && macroEmaFast < macroEmaSlow;

    let intent = "NONE"; 

    // 1. Base Trigger (Trend + Pullback Allowance)
    if (isBullFan && rsi > 45 && rsi < 65 && currentClose > currentOpen) intent = "UP";
    else if (isBearFan && rsi < 55 && rsi > 35 && currentClose < currentOpen) intent = "DOWN";
    
    let pred = intent;

    // 2. The Gauntlet Vetoes (HTF Filter applied here)
    if (pred === "UP" && currentClose < htfEma) pred = "SKIP";   // Must be above 200-hour EMA
    if (pred === "DOWN" && currentClose > htfEma) pred = "SKIP"; // Must be below 200-hour EMA
    if (atrPercentage < 0.05) pred = "SKIP"; 

    // 3. Dynamic Confidence Scoring
    let conf = 40.0; 
    
    if (pred !== "SKIP") {
        if (pred === "UP" && lowerWick > bodySize) conf += 10.0;
        if (pred === "DOWN" && upperWick > bodySize) conf += 10.0;
        if (rvol > 1.5) conf += 8.0;
        if (isExpanding) conf += 5.0;
        if (isWhipsaw) conf -= 15.0;
    }

    if (conf < settings.min_confidence) {
        pred = "SKIP";
    }

    return { pred, intent, conf, atr: rawATR };
}

// ------------------------------------------------------------------
// ARCHITECTURE: FETCHERS & EXCHANGE INIT
// ------------------------------------------------------------------
let activeImpersonator = null;

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

// ------------------------------------------------------------------
// MODULE 1: WALK-FORWARD VALIDATION (BINARY HOLD MECHANICS)
// ------------------------------------------------------------------
async function runBacktest() {
    let allCandles = [];
    const CACHE_FILENAME = 'sol_usdt_cache_3h.json';

    if (fs.existsSync(CACHE_FILENAME)) {
        console.log(`📦 Local cache found! Loading ${CACHE_FILENAME}...`);
        try {
            allCandles = JSON.parse(fs.readFileSync(CACHE_FILENAME, 'utf8'));
            console.log(`✅ Loaded ${allCandles.length} candles from disk.`);
        } catch (err) {
            fs.unlinkSync(CACHE_FILENAME);
        }
    }

    if (allCandles.length === 0) {
        console.log("❌ No cache data found. Please run the data fetcher module first to pull 3H data.");
        return;
    }

    const runSimulation = (dataArray, customRisk) => {
        let wins = 0, losses = 0, breakevens = 0;
        let cumulativeNetPnL = 0, totalWinPnL = 0, totalLossPnL = 0;
        let position = null; 
        let lastExitIndex = 0;
        
        const totalUnits = tradeSettings.amountContracts * tradeSettings.contractSize;

        for (let i = 850; i < dataArray.length - 1; i++) { 
            const currentCandle = dataArray[i];
            const high = currentCandle[2];
            const low = currentCandle[3];
            const close = currentCandle[4];

            if (position) {
                let tradeClosed = false;
                let exitPrice = 0;

                if (position.type === 'UP') {
                    if (low <= position.sl) {
                        exitPrice = position.sl;
                        tradeClosed = true;
                    } else if (high >= position.tp) {
                        exitPrice = position.tp;
                        tradeClosed = true;
                    }
                } 
                else if (position.type === 'DOWN') {
                    if (high >= position.sl) {
                        exitPrice = position.sl;
                        tradeClosed = true;
                    } else if (low <= position.tp) {
                        exitPrice = position.tp;
                        tradeClosed = true;
                    }
                }

                if (tradeClosed) {
                    const entryFee = (position.entry * totalUnits) * customRisk.takerFeePerc;
                    const exitFee = (exitPrice * totalUnits) * customRisk.makerFeePerc;
                    const grossPnL = position.type === 'UP' ? 
                        ((exitPrice - position.entry) * totalUnits) : 
                        ((position.entry - exitPrice) * totalUnits);
                    
                    const netPnL = grossPnL - (entryFee + exitFee);
                    cumulativeNetPnL += netPnL;

                    if (netPnL > 0) { 
                        wins++; totalWinPnL += netPnL; 
                    } else if (netPnL < 0) { 
                        losses++; totalLossPnL += netPnL; 
                    } else {
                        breakevens++;
                    }

                    position = null; 
                    lastExitIndex = i; 
                }
                continue; 
            }

            if (i - lastExitIndex < tradeSettings.cooldownCandles) continue;

            const historicalSlice = dataArray.slice(i - 850, i);
            const { pred, atr } = simulatePrediction(historicalSlice);
            
            if (pred === "UP") {
                const entryPrice = close * (1 + customRisk.slippagePerc);
                position = {
                    type: 'UP', entry: entryPrice, 
                    sl: entryPrice - (atr * customRisk.atrStopMultiplier),
                    tp: entryPrice + (atr * customRisk.atrProfitMultiplier)
                };
            } else if (pred === "DOWN") {
                const entryPrice = close * (1 - customRisk.slippagePerc);
                position = {
                    type: 'DOWN', entry: entryPrice, 
                    sl: entryPrice + (atr * customRisk.atrStopMultiplier),
                    tp: entryPrice - (atr * customRisk.atrProfitMultiplier)
                };
            }
        }

        const totalTrades = wins + losses + breakevens;
        const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0;
        const profitFactor = totalLossPnL !== 0 ? Math.abs(totalWinPnL / totalLossPnL).toFixed(2) : 'Infinity';
        const avgTrade = totalTrades > 0 ? (cumulativeNetPnL / totalTrades).toFixed(2) : 0;
        
        return { trades: totalTrades, winRate, pnl: cumulativeNetPnL, profitFactor, avgTrade };
    };

    console.log(`\n ─── PnL Optimized Sizing: ${tradeSettings.amountContracts} Contracts @ ${tradeSettings.leverage}x Leverage ───`);
    
    const epochSize = Math.floor(allCandles.length / 5);
    let totalAggregatePnL = 0;
    
    console.log(`\n🚶 Initiating Walk-Forward Validation (5 Epochs of ~${epochSize} Candles)...`);

    for (let epochNum = 1; epochNum <= 5; epochNum++) {
        const startIndex = (epochNum - 1) * epochSize;
        const endIndex = epochNum === 5 ? allCandles.length : startIndex + epochSize; 
        const epochData = allCandles.slice(startIndex, endIndex);
        
        const metrics = runSimulation(epochData, riskSettings);
        totalAggregatePnL += metrics.pnl;

        const pnlColor = metrics.pnl >= 0 ? "🟢" : "🔴";
        console.log(`   ${pnlColor} Epoch ${epochNum} | Net PnL: ${metrics.pnl.toFixed(2)} USDT | WR: ${metrics.winRate}% | PF: ${metrics.profitFactor} | EV/Trade: ${metrics.avgTrade}`);
    }

    console.log(`\n✅ Walk-Forward Complete. Net Aggregate PnL: ${totalAggregatePnL.toFixed(2)} USDT`);
}

async function startSystem() {
    console.log("⚙️ Initializing Trading Engine (Binary Hold Mode) on 3H Timeframe...");
    await runBacktest(); 
}

startSystem();