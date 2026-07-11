// upsidedowncake - Jupiter Perps 15-Minute ADX Specialist Adapter (SOL ONLY)
const fs = require('fs');

const RECORD_ML_DATA = true;
const RECORD_ALL_RAW_INTENTS = true; 

const settings = {
    ema_fast_period: 9,      
    ema_slow_period: 21,     
    macro_ema_fast: 50,      
    macro_ema_slow: 100,
    htf_macro_ema: 200,      
    min_confidence: 58,        
    adx_period: 14,
    min_adx_trend_strength: 20 
};

const tradeSettings = {
    contractSize: 1,            
    amountContracts: 1.0,       
    leverage: 5,                
    cooldownCandles: 1,         
    max_consecutive_losses: 2,  
    penalty_cooldown_candles: 8 
};

const riskSettings = {
    atrStopMultiplier: 2.0,   
    atrProfitMultiplier: 4.0, 
    slippagePerc: 0.0002,       // 0.02% - Matches 'Price Impact'
    openFeePerc: 0.0006,        // 0.06% - Matches 'Open Fee'
    closeFeePerc: 0.0006,       // 0.06% - Closing fee
    borrowFeePerHourPerc: 0.001,// 0.1% per hour estimate for JLP utilization
    priorityFeeUsd: 0.02        // Estimated flat network fee
};

// ------------------------------------------------------------------
// MATH HELPERS
// ------------------------------------------------------------------
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
    if (closes.length < 15) return 50;
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

const calculateADX = (highs, lows, closes, period) => {
    if (highs.length <= period) return 0;
    
    let trs = [], pdms = [], ndms = [];
    for (let i = 1; i < highs.length; i++) {
        const h = highs[i], l = lows[i], ph = highs[i-1], pl = lows[i-1], pc = closes[i-1];
        const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        const pdm = (h - ph > pl - l) ? Math.max(h - ph, 0) : 0;
        const ndm = (pl - l > h - ph) ? Math.max(pl - l, 0) : 0;
        trs.push(tr); pdms.push(pdm); ndms.push(ndm);
    }
    
    const smooth = (val, prev, p) => prev - (prev / p) + val;
    
    let str = trs.slice(0, period).reduce((a,b)=>a+b,0);
    let spdm = pdms.slice(0, period).reduce((a,b)=>a+b,0);
    let sndm = ndms.slice(0, period).reduce((a,b)=>a+b,0);
    
    let dxs = [];
    for (let i = period; i < trs.length; i++) {
        str = smooth(trs[i], str, period);
        spdm = smooth(pdms[i], spdm, period);
        sndm = smooth(ndms[i], sndm, period);
        
        const pdi = 100 * (spdm / str);
        const ndi = 100 * (sndm / str);
        
        let dx = 0;
        if (pdi + ndi > 0) dx = 100 * (Math.abs(pdi - ndi) / (pdi + ndi));
        dxs.push(dx);
    }
    
    if (dxs.length < period) return 0;
    
    let adx = dxs.slice(0, period).reduce((a,b)=>a+b,0) / period;
    for (let i = period; i < dxs.length; i++) {
        adx = ((adx * (period - 1)) + dxs[i]) / period;
    }
    return adx;
};

function resampleCandles(ltfCandles, factor) {
    const htfCandles = [];
    const sample = ltfCandles[0];
    const isArrayFormat = Array.isArray(sample);
    
    const getVal = (candle, arrayIndex, objectKey) => {
        if (!candle) return 0;
        if (isArrayFormat) return parseFloat(candle[arrayIndex] || 0);
        return parseFloat(candle[objectKey] || candle[objectKey.toUpperCase()] || 0);
    };

    const getTimestamp = (candle) => {
        if (!candle) return Date.now();
        if (isArrayFormat) return candle[0];
        return candle.time || candle.timestamp || candle.date || Date.now();
    };

    for (let i = 0; i < ltfCandles.length; i += factor) {
        const chunk = ltfCandles.slice(i, i + factor);
        if (chunk.length < factor) continue; 
        
        const timestamp = getTimestamp(chunk[0]);               
        const open = getVal(chunk[0], 1, 'open');                    
        const high = Math.max(...chunk.map(c => getVal(c, 2, 'high'))); 
        const low = Math.min(...chunk.map(c => getVal(c, 3, 'low')));  
        const close = getVal(chunk[chunk.length - 1], 4, 'close');    
        const volume = chunk.reduce((sum, c) => sum + getVal(c, 5, 'volume'), 0); 
        
        if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;
        htfCandles.push([timestamp, open, high, low, close, volume]);
    }
    return htfCandles;
}

// ------------------------------------------------------------------
// CORE ENGINE PREDICTION
// ------------------------------------------------------------------
function simulatePrediction(candles) {
    if (candles.length < 250) return { pred: "NONE", intent: "NONE", conf: 0, atr: 0, mlFeatures: null };

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
    const htfEma = calculateEMAArray(closes, settings.htf_macro_ema).pop();
    
    const currentADX = calculateADX(highs, lows, closes, settings.adx_period);
    const prevADX = calculateADX(highs.slice(0, -1), lows.slice(0, -1), closes.slice(0, -1), settings.adx_period);
    
    const volSMA20 = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const rvol = volumes[idx] / (volSMA20 || 1);

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

    const isBullFan = emaFast > emaSlow && emaSlow > macroEmaFast;
    const isBearFan = emaFast < emaSlow && emaSlow < macroEmaFast;

    let intent = "NONE"; 
    const touchesFastEmaLong = currentLow <= emaFast && currentClose > emaFast;
    const touchesFastEmaShort = currentHigh >= emaFast && currentClose < emaFast;

    if (isBullFan && touchesFastEmaLong) intent = "UP";
    else if (isBearFan && touchesFastEmaShort) intent = "DOWN";

    let pred = intent;
    let isSkipped = false;
    let dynamicConfThreshold = settings.min_confidence;

    if (intent !== "NONE") {
        if (intent === "UP" && currentClose < htfEma) dynamicConfThreshold = 75; 
        else if (intent === "DOWN" && currentClose > htfEma) dynamicConfThreshold = 75;

        if (!isSkipped && atrPercentage < 0.05) isSkipped = true;
        if (!isSkipped && currentADX < settings.min_adx_trend_strength) isSkipped = true;
    }

    let conf = 40.0; 
    if (intent !== "NONE") {
        if (intent === "UP" && lowerWick > bodySize) conf += 15.0; 
        if (intent === "DOWN" && upperWick > bodySize) conf += 15.0;
        if (rvol > 1.5) conf += 10.0;
        if (isWhipsaw) conf -= 15.0;
    }

    if (intent !== "NONE" && !isSkipped && conf < dynamicConfThreshold) isSkipped = true;

    if (isSkipped && intent !== "NONE") pred = `${intent} (Skipped)`;
    else if (isSkipped) pred = "NONE";

    const mlFeatures = {
        rsi: rsi.toFixed(4),
        currentADX: currentADX.toFixed(4),
        prevADX: prevADX.toFixed(4),
        rvol: rvol.toFixed(4),
        atrPercentage: atrPercentage.toFixed(4),
        upperWick: upperWick.toFixed(4),
        lowerWick: lowerWick.toFixed(4),
        bodySize: bodySize.toFixed(4),
        isWhipsaw: isWhipsaw ? 1 : 0,
        directionIntent: intent === "UP" ? 1 : (intent === "DOWN" ? -1 : 0)
    };

    return { pred, intent, conf, atr: rawATR, mlFeatures };
}

// ------------------------------------------------------------------
// CORE SIMULATION RUNNER
// ------------------------------------------------------------------
const runSimulation = (allCandles, customRisk, startIndex, endIndex, csvFileName, carryState = null) => {
    let wins = 0, losses = 0, breakevens = 0;
    let cumulativeNetPnL = 0;
    
    let position = carryState ? carryState.position : null; 
    let lastExitIndex = carryState ? carryState.lastExitIndex : 0;
    let consecutiveLosses = carryState ? carryState.consecutiveLosses : 0;
    let dynamicCooldownUntil = carryState ? carryState.dynamicCooldownUntil : 0; 
    
    const totalUnits = tradeSettings.amountContracts * tradeSettings.contractSize;

    for (let i = startIndex; i < endIndex; i++) {
        if (i < dynamicCooldownUntil) continue;

        const currentCandle = allCandles[i]; 
        const high = currentCandle[2];
        const low = currentCandle[3];
        const close = currentCandle[4];

        if (position) {
            let tradeClosed = false;
            let exitPrice = 0;

            const breakevenTrigger = position.atr * 2.0; 
            const feeBuffer = position.entry * customRisk.openFeePerc * 2; 

            if (position.type === 'UP') {
                if (high >= position.entry + breakevenTrigger && position.sl < position.entry) position.sl = position.entry + feeBuffer; 
                if (low <= position.sl) { exitPrice = position.sl; tradeClosed = true; }
                else if (high >= position.tp) { exitPrice = position.tp; tradeClosed = true; }
            } 
            else if (position.type === 'DOWN') {
                if (low <= position.entry - breakevenTrigger && position.sl > position.entry) position.sl = position.entry - feeBuffer; 
                if (high >= position.sl) { exitPrice = position.sl; tradeClosed = true; } 
                else if (low <= position.tp) { exitPrice = position.tp; tradeClosed = true; }
            }

            if (tradeClosed) {
                // 1. Calculate time held to figure out Jupiter Borrow Fees
                const candlesHeld = i - position.entryIndex;
                const hoursHeld = candlesHeld * (5 / 60); // 5m timeframe math
                
                // 2. Calculate Jupiter DEX Fees
                const positionSizeValue = position.entry * totalUnits;
                const entryFee = positionSizeValue * customRisk.openFeePerc;
                const exitFee = (exitPrice * totalUnits) * customRisk.closeFeePerc;
                const borrowFee = positionSizeValue * (customRisk.borrowFeePerHourPerc * hoursHeld);
                const networkFees = customRisk.priorityFeeUsd * 2; // Paid twice (open and close)

                // 3. Final PnL Math
                const grossPnL = position.type === 'UP' ? ((exitPrice - position.entry) * totalUnits) : ((position.entry - exitPrice) * totalUnits);
                const netPnL = grossPnL - (entryFee + exitFee + borrowFee + networkFees);
                cumulativeNetPnL += netPnL;

                // Write directly to the specific asset's CSV
                if (RECORD_ML_DATA && position.features && (!position.isVirtual || RECORD_ALL_RAW_INTENTS)) {
                    const isWin = netPnL > 0 ? 1 : 0;
                    const f = position.features;
                    const csvRow = `${f.rsi},${f.currentADX},${f.prevADX},${f.rvol},${f.atrPercentage},${f.upperWick},${f.lowerWick},${f.bodySize},${f.isWhipsaw},${f.directionIntent},${isWin}\n`;
                    fs.appendFileSync(csvFileName, csvRow);
                }

                if (netPnL > 0) { 
                    wins++; 
                    if (!position.isVirtual) consecutiveLosses = 0; 
                } else if (netPnL < 0) { 
                    losses++; 
                    if (!position.isVirtual) {
                        consecutiveLosses++;  
                        if (consecutiveLosses >= tradeSettings.max_consecutive_losses) {
                            dynamicCooldownUntil = i + tradeSettings.penalty_cooldown_candles;
                            consecutiveLosses = 0; 
                        }
                    }
                } else breakevens++;

                if (!position.isVirtual) lastExitIndex = i; 
                position = null; 
            }
            continue; 
        }

        if (i - lastExitIndex < tradeSettings.cooldownCandles) continue;
        const historicalSlice = allCandles.slice(i - 250, i);
        const { pred, intent, atr, mlFeatures } = simulatePrediction(historicalSlice);
        const isSkippedTrade = pred.includes("(Skipped)");
        
        if (pred === "UP" || (RECORD_ALL_RAW_INTENTS && isSkippedTrade && intent === "UP")) {
            const entryPrice = close * (1 + customRisk.slippagePerc);
            position = { type: 'UP', entry: entryPrice, sl: entryPrice - (atr * customRisk.atrStopMultiplier), tp: entryPrice + (atr * customRisk.atrProfitMultiplier), atr: atr, features: mlFeatures, isVirtual: isSkippedTrade, entryIndex: i };
        } else if (pred === "DOWN" || (RECORD_ALL_RAW_INTENTS && isSkippedTrade && intent === "DOWN")) {
            const entryPrice = close * (1 - customRisk.slippagePerc);
            position = { type: 'DOWN', entry: entryPrice, sl: entryPrice + (atr * customRisk.atrStopMultiplier), tp: entryPrice - (atr * customRisk.atrProfitMultiplier), atr: atr, features: mlFeatures, isVirtual: isSkippedTrade, entryIndex: i };
        }
    }
    
    return { 
        trades: wins + losses + breakevens, pnl: cumulativeNetPnL,
        endState: { position, lastExitIndex, consecutiveLosses, dynamicCooldownUntil }
    };
};

// ------------------------------------------------------------------
// SINGLE ASSET ORCHESTRATOR
// ------------------------------------------------------------------
async function startSystem() {
    const CACHE_FILENAME = `sol_usdt_cache.json`;
    const CSV_FILENAME = `training_sol.csv`;
    
    console.log(`\n===============================================================`);
    console.log(`🚀 PROCESSING ASSET: SOLANA (SOL)`);
    console.log(`===============================================================`);

    if (!fs.existsSync(CACHE_FILENAME)) {
        console.log(`⏭️ No cache data found for SOL. Please run fetcher.js first.`);
        return;
    }

    if (RECORD_ML_DATA) {
        fs.writeFileSync(CSV_FILENAME, "rsi,currentADX,prevADX,rvol,atrPercentage,upperWick,lowerWick,bodySize,isWhipsaw,directionIntent,target_win\n");
        console.log(`📁 Initialized dedicated dataset: ${CSV_FILENAME}`);
    }

    let allCandles = [];
    try {
        const rawCandles = JSON.parse(fs.readFileSync(CACHE_FILENAME, 'utf8'));
        allCandles = resampleCandles(rawCandles, 3); // Downsamples 5m candles to 15m intervals
    } catch (err) {
        console.log(`❌ Error reading/parsing cache for SOL`);
        return; 
    }

    console.log(`⚙️ Running Backtest Simulation on SOL...`);
    const epochSize = Math.floor(allCandles.length / 5);
    let botState = null; 

    for (let epochNum = 1; epochNum <= 5; epochNum++) {
        const startIndex = epochNum === 1 ? 250 : (epochNum - 1) * epochSize;
        const endIndex = epochNum === 5 ? allCandles.length - 1 : epochNum * epochSize; 
        
        const metrics = runSimulation(allCandles, riskSettings, startIndex, endIndex, CSV_FILENAME, botState);
        botState = metrics.endState; 
        console.log(`   Epoch ${epochNum} | Trades: ${metrics.trades} | PnL: ${metrics.pnl.toFixed(2)} USD`);
    }
    console.log(`✅ SOL Complete! Dataset saved to ${CSV_FILENAME}.\n`);
}

startSystem();
