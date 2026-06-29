import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './src/config.js';
import { TokenMonitor } from './src/monitor.js';
import { Trader } from './src/trader.js';
import dotenv from 'dotenv';

dotenv.config();

// ── Global Crash Protection ────────────────────────────────────────────────
// Αποτρέπει το server να πεθάνει από unhandled errors στα tracking intervals
process.on('uncaughtException', (err) => {
    console.log(`[SYSTEM] ⚠️ Uncaught Exception (non-fatal): ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.log(`[SYSTEM] ⚠️ Unhandled Rejection (non-fatal): ${msg}`);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Αντικείμενα του Bot
const monitor = new TokenMonitor(
    process.env.RPC_URL,
    process.env.WSS_URL
);
const trader = new Trader();

let isRunning = false;
let logs = [];

// Αρχειοθέτηση των console.log για να τα στέλνουμε στο Frontend
const originalConsoleLog = console.log;
console.log = function(...args) {
    const msg = args.join(' ');
    logs.push({ time: new Date().toLocaleTimeString(), msg });
    if (logs.length > 100) logs.shift(); // Κρατάμε τα τελευταία 100
    originalConsoleLog.apply(console, args);
};

// Global State
export const AppState = {
    activePositions: [],
    tradeHistory: [],
    dailyPnL: 0,
    walletBalance: 0,
    virtualCapital: CONFIG.MAX_CAPITAL_SOL   // Εικονικό κεφάλαιο που παρακολουθείται
};

trader.appState = AppState;

// --- API ROUTES ---

// Authentication Middleware
function requireAuth(req, res, next) {
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
        // Αν δεν έχει οριστεί κωδικός, επιτρέπουμε την πρόσβαση (ή μπορούμε να την μπλοκάρουμε)
        return next();
    }
    
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== adminPassword) {
        return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or missing password' });
    }
    next();
}

app.get('/api/status', (req, res) => {
    // Αφαιρούμε το intervalId γιατί είναι circular object (Timeout) και "σκάει" το JSON.stringify
    const safePositions = AppState.activePositions.map(pos => ({
        id: pos.id,
        symbol: pos.symbol,
        amount: pos.amount,
        status: pos.status,
        pnl: pos.pnl,
        maxPnl: pos.maxPnl || 0,
        entryPrice: pos.entryPrice,
        tp1Hit: pos.tp1Hit || false,
        tp2Hit: pos.tp2Hit || false
    }));

    // Υπολογισμός deployed κεφαλαίου
    const deployedCapital = AppState.activePositions.reduce((sum, p) => sum + (p.amount || 0), 0);
    const remainingCapital = Math.max(0, CONFIG.MAX_CAPITAL_SOL - deployedCapital);

    res.json({ 
        isRunning, 
        config: CONFIG,
        activePositions: safePositions,
        tradeHistory: AppState.tradeHistory,
        dailyPnL: AppState.dailyPnL,
        walletBalance: AppState.walletBalance,
        maxCapital: CONFIG.MAX_CAPITAL_SOL,
        deployedCapital: Math.round(deployedCapital * 10000) / 10000,
        remainingCapital: Math.round(remainingCapital * 10000) / 10000
    });
});

app.post('/api/start', requireAuth, (req, res) => {
    if (!isRunning) {
        console.log("[SERVER] Εντολή εκκίνησης από το UI...");
        monitor.startMonitoring((tokenSignature) => {
            trader.buyToken(tokenSignature);
        });
        isRunning = true;
        res.json({ success: true, message: 'Sniper Bot Started' });
    } else {
        res.json({ success: false, message: 'Already running' });
    }
});

app.post('/api/stop', requireAuth, (req, res) => {
    if (isRunning) {
        console.log("[SERVER] Εντολή τερματισμού από το UI...");
        monitor.stopMonitoring();
        isRunning = false;
        res.json({ success: true, message: 'Sniper Bot Stopped' });
    } else {
        res.json({ success: false, message: 'Not running' });
    }
});

// ΝΕΟ: API για logs
app.get('/api/logs', (req, res) => {
    res.json({ logs });
});

app.post('/api/panic-sell', requireAuth, async (req, res) => {
    const { tokenAddress } = req.body;
    console.log(`[SERVER] 🚨 PANIC SELL ΖΗΤΗΘΗΚΕ ΓΙΑ ΤΟ: ${tokenAddress}`);
    await trader.panicSell(tokenAddress);
    res.json({ success: true });
});

app.post('/api/sell-half', requireAuth, async (req, res) => {
    const { tokenAddress } = req.body;
    console.log(`[SERVER] ⚖️ SCALE OUT (50%) ΖΗΤΗΘΗΚΕ ΓΙΑ ΤΟ: ${tokenAddress}`);
    await trader.sellHalf(tokenAddress);
    res.json({ success: true });
});

app.post('/api/config', requireAuth, (req, res) => {
    const {
        buyAmount, maxCapital, paperTrading,
        takeProfit1, takeProfit2, stopLoss,
        trailingStopLoss, trailingActivateAt, autoSellTimeoutSec,
        entryDelaySec, minLiquidity, minVolume5m,
        minMarketCap, maxMarketCap, maxPumpPct,
        slippagePct, requireSocials
    } = req.body;

    if (buyAmount     !== undefined) CONFIG.BUY_AMOUNT_SOL                  = parseFloat(buyAmount);
    if (maxCapital    !== undefined) CONFIG.MAX_CAPITAL_SOL                  = parseFloat(maxCapital);
    if (paperTrading  !== undefined) CONFIG.PAPER_TRADING                    = paperTrading;
    if (takeProfit1   !== undefined) CONFIG.TAKE_PROFIT_1_PCT                = parseFloat(takeProfit1);
    if (takeProfit2   !== undefined) CONFIG.TAKE_PROFIT_2_PCT                = parseFloat(takeProfit2);
    if (stopLoss      !== undefined) CONFIG.STOP_LOSS_PERCENTAGE             = parseFloat(stopLoss);
    if (trailingStopLoss    !== undefined) CONFIG.TRAILING_STOP_LOSS_PERCENTAGE = parseFloat(trailingStopLoss);
    if (trailingActivateAt  !== undefined) CONFIG.TRAILING_ACTIVATE_AT_PCT    = parseFloat(trailingActivateAt);
    if (autoSellTimeoutSec  !== undefined) CONFIG.AUTO_SELL_TIMEOUT_SEC        = parseInt(autoSellTimeoutSec);
    if (entryDelaySec       !== undefined) CONFIG.ENTRY_DELAY_SEC              = parseInt(entryDelaySec);
    if (minLiquidity        !== undefined) CONFIG.MIN_LIQUIDITY_USD            = parseFloat(minLiquidity);
    if (minVolume5m         !== undefined) CONFIG.MIN_VOLUME_5M_USD            = parseFloat(minVolume5m);
    if (minMarketCap        !== undefined) CONFIG.MIN_MARKET_CAP_USD           = parseFloat(minMarketCap);
    if (maxMarketCap        !== undefined) CONFIG.MAX_MARKET_CAP_USD           = parseFloat(maxMarketCap);
    if (maxPumpPct          !== undefined) CONFIG.MAX_PUMP_PCT                 = parseFloat(maxPumpPct);
    if (slippagePct         !== undefined) CONFIG.SLIPPAGE_SIMULATION_PCT      = parseFloat(slippagePct);
    if (requireSocials      !== undefined) CONFIG.REQUIRE_SOCIALS              = requireSocials;

    trader.isPaperTrading = CONFIG.PAPER_TRADING;
    // Reset dedup on config change so bot can re-evaluate tokens
    trader.boughtTokens.clear();

    console.log(`[SERVER] ⚙️ Config updated | Budget: ${CONFIG.MAX_CAPITAL_SOL} SOL | Trade: ${CONFIG.BUY_AMOUNT_SOL} SOL | Paper: ${CONFIG.PAPER_TRADING}`);
    res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`\n╔=========================================╗`);
    console.log(`║      FREE SOLANA SNIPER WEB UI        ║`);
    console.log(`╚=========================================╝`);
    console.log(`[+] Server running at: http://localhost:${PORT}`);
    console.log(`[+] Άνοιξε τον browser σου σε αυτό το link!\n`);
});
