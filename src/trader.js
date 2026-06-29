import { CONFIG } from './config.js';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { SafetyChecker } from './safety.js';

export class Trader {
    constructor() {
        this.isPaperTrading = CONFIG.PAPER_TRADING;
        const rpcUrl        = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
        this.connection     = new Connection(rpcUrl);
        this.safety         = new SafetyChecker(rpcUrl);
        this.appState       = null;
        this.boughtTokens   = new Set();
        this.solPriceUsd    = 150;

        // Ανανέωση SOL τιμής
        this.fetchSolPrice();
        setInterval(() => this.fetchSolPrice(), 60000);

        try {
            const privateKeyBytes = bs58.decode(process.env.PRIVATE_KEY);
            this.wallet = Keypair.fromSecretKey(privateKeyBytes);
            console.log(`[TRADER] 🟢 Wallet: ${this.wallet.publicKey.toBase58()}`);
            this.initWalletBalance();
        } catch (e) {
            console.log(`[TRADER] 🔴 Σφάλμα φόρτωσης Private Key.`);
        }
    }

    async fetchSolPrice() {
        try {
            const r = await fetch('https://price.jup.ag/v4/price?ids=SOL');
            const d = await r.json();
            this.solPriceUsd = d?.data?.SOL?.price || this.solPriceUsd;
        } catch(e) {}
    }

    async initWalletBalance() {
        if (!this.wallet) return;
        try {
            const lamports = await this.connection.getBalance(this.wallet.publicKey);
            if (this.appState) this.appState.walletBalance = lamports / 1_000_000_000;
            console.log(`[TRADER] 💰 Wallet: ${this.appState?.walletBalance ?? 0} SOL`);
            setInterval(async () => {
                try {
                    const l = await this.connection.getBalance(this.wallet.publicKey);
                    if (this.appState) this.appState.walletBalance = l / 1_000_000_000;
                } catch(e) {}
            }, 30000);
        } catch(e) {}
    }

    // ── Pump.fun API price (άμεση τιμή για νέα tokens) ───────────────────
    async getPumpFunPrice(mintAddress) {
        try {
            const r = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress}`);
            if (!r.ok) return null;
            const d = await r.json();
            if (!d || d.usd_market_cap === undefined) return null;

            // Τιμή = MC / supply (pump.fun tokens = 1B supply)
            const priceUsd = (d.usd_market_cap || 0) / 1_000_000_000;
            if (priceUsd <= 0) return null;

            return {
                price:     priceUsd,
                marketCap: d.usd_market_cap || 0,
                liquidity: ((d.sol_in_bonding_curve || 0) / 1e9) * this.solPriceUsd,
                volume5m:  0, // pump.fun δεν δίνει 5m volume
                complete:  d.complete || false,
                symbol:    d.symbol || '?',
                name:      d.name   || '?',
                source:    'pumpfun'
            };
        } catch(e) { return null; }
    }

    // ── DexScreener price (για graduated tokens) ─────────────────────────
    async getDexScreenerPrice(mintAddress) {
        try {
            const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
            const data = await res.json();
            if (!data?.pairs?.length) return null;
            const best = data.pairs
                .filter(p => p.priceUsd && parseFloat(p.priceUsd) > 0)
                .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            if (!best) return null;
            return {
                price:     parseFloat(best.priceUsd),
                liquidity: best.liquidity?.usd || 0,
                volume5m:  best.volume?.m5 || 0,
                marketCap: best.marketCap || best.fdv || 0,
                source:    'dexscreener'
            };
        } catch(e) { return null; }
    }

    // ── Παίρνει τιμή από οπουδήποτε (Pump.fun πρώτα, DexScreener fallback) ──
    async getTokenPrice(mintAddress) {
        const pumpData = await this.getPumpFunPrice(mintAddress);
        if (pumpData) return pumpData;
        return await this.getDexScreenerPrice(mintAddress);
    }

    // ── ΑΓΟΡΑ ─────────────────────────────────────────────────────────────
    async buyToken(tokenAddress) {
        // Dedup — αθόρυβο, χωρίς log για μείωση noise
        if (this.boughtTokens.has(tokenAddress)) return;
        this.boughtTokens.add(tokenAddress);
        if (this.boughtTokens.size > 500) this.boughtTokens.clear();

        // Όριο ταυτόχρονων θέσεων & Capital check ΠΡΩΤΑ — αν γεμάτο, δεν κάνουμε κανένα RPC call
        if (this.appState) {
            // Περιορισμός σε MAX 2 Trades ταυτόχρονα
            if (this.appState.activePositions.length >= 2) return; // αθόρυβο skip
            
            const deployed = this.appState.activePositions.reduce((s, p) => s + (p.amount || 0), 0);
            if (CONFIG.BUY_AMOUNT_SOL > CONFIG.MAX_CAPITAL_SOL - deployed) return; // αθόρυβο skip
        }

        console.log(`\n═══════════════════════════════════════`);
        console.log(`[ACTION] 🎯 ${tokenAddress.substring(0,8)}...`);

        // Safety (μόνο αν έχουμε διαθέσιμο budget)
        const isSafe = await this.safety.isTokenSafe(tokenAddress);
        if (!isSafe) { console.log(`[ACTION] 🛑 Safety check failed.`); return; }

        // Entry delay
        if (CONFIG.ENTRY_DELAY_SEC > 0) {
            console.log(`[ENTRY] ⏳ Αναμονή ${CONFIG.ENTRY_DELAY_SEC}s...`);
            await new Promise(r => setTimeout(r, CONFIG.ENTRY_DELAY_SEC * 1000));
        }

        // Τιμή εισόδου (Pump.fun αμέσως ή DexScreener)
        console.log(`[ENTRY] 💰 Λήψη τιμής εισόδου...`);
        const tokenData = await this.getTokenPrice(tokenAddress);
        if (!tokenData?.price) {
            console.log(`[ENTRY] ❌ Δεν βρέθηκε τιμή. Skip.`); return;
        }

        const slippage   = 1 + (CONFIG.SLIPPAGE_SIMULATION_PCT / 100);
        const entryPrice = tokenData.price * slippage;
        const src = tokenData.source || '?';

        console.log(`[ENTRY] ✅ ${tokenData.symbol || tokenAddress.substring(0,8)} @ $${entryPrice.toExponential(4)} [${src}]`);
        console.log(`[ENTRY] 📊 MC: $${(tokenData.marketCap||0).toFixed(0)} | Liq: $${(tokenData.liquidity||0).toFixed(0)}`);

        const position = {
            id: tokenAddress,
            symbol: tokenData.symbol || tokenAddress.substring(0,6),
            amount: CONFIG.BUY_AMOUNT_SOL,
            entryPrice,
            currentPrice: entryPrice,
            status: 'Holding',
            pnl: 0, maxPnl: 0,
            tp1Hit: false, tp2Hit: false,
            source: src,
            intervalId: null,
            stopTracking: null // Νέο lock για τα recursive timeouts
        };

        if (this.appState) this.appState.activePositions.push(position);

        if (this.isPaperTrading) {
            console.log(`[PAPER] 🟢 Paper trade open | ${CONFIG.BUY_AMOUNT_SOL} SOL`);
            this.trackPrice(tokenAddress, position);
        } else {
            await this.executeLiveBuy(tokenAddress, position);
        }
    }

    // ── Price Tracking ──────────────────────────────────────────────────
    trackPrice(tokenAddress, positionRef) {
        let elapsed       = 0;
        let failedFetches = 0;
        const INTERVAL_MS = 20000;
        let isStopped     = false;

        positionRef.stopTracking = () => {
            isStopped = true;
            if (positionRef.intervalId) clearTimeout(positionRef.intervalId);
        };

        const jitter = Math.random() * 15000;
        
        const fetchCycle = async () => {
            if (isStopped) return;
            elapsed += INTERVAL_MS / 1000;

            const data = await this.getTokenPrice(tokenAddress);

            if (data?.price && data.price > 0 && positionRef.entryPrice > 0) {
                positionRef.currentPrice = data.price;
                positionRef.pnl = ((data.price - positionRef.entryPrice) / positionRef.entryPrice) * 100;
                positionRef.source = data.source;
                failedFetches = 0;

                if (positionRef.pnl > positionRef.maxPnl) positionRef.maxPnl = positionRef.pnl;

                // Rug detection
                if (positionRef.pnl < -85 && elapsed < 120) {
                    positionRef.stopTracking();
                    console.log(`[TRACK] 🚨 RUG! ${positionRef.pnl.toFixed(1)}%`);
                    await this._closePosition(tokenAddress, positionRef, "🚨 Rug Detected"); return;
                }

                const sign = positionRef.pnl >= 0 ? '+' : '';
                console.log(`[TRACK] ${positionRef.symbol || tokenAddress.substring(0,8)} | $${data.price.toExponential(3)} | ${sign}${positionRef.pnl.toFixed(2)}% | Peak:+${positionRef.maxPnl.toFixed(2)}% [${data.source}]`);
            } else {
                failedFetches++;
                console.log(`[TRACK] ⚠️ ${tokenAddress.substring(0,8)} — fetch failed (${failedFetches}/12)`);
                if (failedFetches >= 12) {
                    positionRef.stopTracking();
                    console.log(`[TRACK] 💀 Token εξαφανίστηκε. Rug/Dead.`);
                    await this._closePosition(tokenAddress, positionRef, "💀 Rug/Dead"); return;
                }
            }

            // ── EXIT CONDITIONS ─────────────────────────────────────────
            // TP1: Πούλα 50%
            if (!positionRef.tp1Hit && positionRef.pnl >= CONFIG.TAKE_PROFIT_1_PCT) {
                positionRef.tp1Hit = true;
                if (!this.isPaperTrading) await this.executeLiveSell(tokenAddress, 50);
                const half   = positionRef.amount / 2;
                const profit = half * (positionRef.pnl / 100);
                positionRef.amount = half;
                if (this.appState) this.appState.dailyPnL += profit;
                console.log(`[TP1] 🎯 +${CONFIG.TAKE_PROFIT_1_PCT}%! Sell 50% | +${profit.toFixed(4)} SOL. Continuing...`);
                this._logPartialClose(tokenAddress, positionRef, `TP1 +${CONFIG.TAKE_PROFIT_1_PCT}%`, profit);
            }
            // TP2: Πούλα άλλο 50%
            else if (positionRef.tp1Hit && !positionRef.tp2Hit && positionRef.pnl >= CONFIG.TAKE_PROFIT_2_PCT) {
                positionRef.tp2Hit = true;
                if (!this.isPaperTrading) await this.executeLiveSell(tokenAddress, 50);
                const half   = positionRef.amount / 2;
                const profit = half * (positionRef.pnl / 100);
                positionRef.amount = half;
                if (this.appState) this.appState.dailyPnL += profit;
                console.log(`[TP2] 🎯 +${CONFIG.TAKE_PROFIT_2_PCT}%! Sell 50% | +${profit.toFixed(4)} SOL. Trailing stop now.`);
                this._logPartialClose(tokenAddress, positionRef, `TP2 +${CONFIG.TAKE_PROFIT_2_PCT}%`, profit);
            }
            // Trailing Stop
            else if (positionRef.maxPnl >= CONFIG.TRAILING_ACTIVATE_AT_PCT &&
                (positionRef.maxPnl - positionRef.pnl) >= CONFIG.TRAILING_STOP_LOSS_PERCENTAGE) {
                positionRef.stopTracking();
                await this._closePosition(tokenAddress, positionRef, `Trailing Stop (peak:+${positionRef.maxPnl.toFixed(1)}%)`); return;
            }
            // Hard Stop Loss
            else if (positionRef.pnl <= -CONFIG.STOP_LOSS_PERCENTAGE) {
                positionRef.stopTracking();
                await this._closePosition(tokenAddress, positionRef, `Stop Loss -${CONFIG.STOP_LOSS_PERCENTAGE}%`); return;
            }
            // Auto-sell timeout
            else if (elapsed >= CONFIG.AUTO_SELL_TIMEOUT_SEC) {
                positionRef.stopTracking();
                await this._closePosition(tokenAddress, positionRef, `Timeout ${CONFIG.AUTO_SELL_TIMEOUT_SEC}s`); return;
            }

            if (!isStopped) {
                positionRef.intervalId = setTimeout(fetchCycle, INTERVAL_MS);
            }
        };

        setTimeout(() => {
            if (!isStopped) positionRef.intervalId = setTimeout(fetchCycle, INTERVAL_MS);
        }, jitter);
    }

    async _closePosition(tokenAddress, positionRef, reason) {
        if (!this.isPaperTrading) {
            await this.executeLiveSell(tokenAddress, 100);
        }
        const pnlAmount = positionRef.amount * (positionRef.pnl / 100);
        if (this.appState) this.appState.dailyPnL += pnlAmount;
        const emoji = positionRef.pnl > 0 ? '📈' : '📉';
        const sign  = pnlAmount >= 0 ? '+' : '';
        console.log(`[CLOSE] ${emoji} ${reason} | ${positionRef.pnl >= 0 ? '+' : ''}${positionRef.pnl.toFixed(2)}% | ${sign}${pnlAmount.toFixed(4)} SOL`);
        this.removeAndLogPosition(tokenAddress, reason, positionRef.pnl, pnlAmount);
    }

    _logPartialClose(tokenAddress, positionRef, reason, solDelta) {
        if (!this.appState) return;
        this.appState.tradeHistory.unshift({
            id: tokenAddress, reason, pnl: positionRef.pnl,
            solDelta, time: new Date().toLocaleTimeString()
        });
        if (this.appState.tradeHistory.length > 50) this.appState.tradeHistory.pop();
    }

    async panicSell(tokenAddress) {
        const pos = this.appState?.activePositions.find(p => p.id === tokenAddress);
        if (!pos) return;
        if (pos.stopTracking) pos.stopTracking();

        if (!this.isPaperTrading) {
            await this.executeLiveSell(tokenAddress, 100);
        }

        const pnlAmt = (pos.amount || CONFIG.BUY_AMOUNT_SOL) * ((pos.pnl || 0) / 100);
        if (this.appState) this.appState.dailyPnL += pnlAmt;
        this.removeAndLogPosition(tokenAddress, "🚨 Panic Sell", pos.pnl || 0, pnlAmt);
    }

    async sellHalf(tokenAddress) {
        const pos = this.appState?.activePositions.find(p => p.id === tokenAddress);
        if (!pos) return;

        if (!this.isPaperTrading) {
            const success = await this.executeLiveSell(tokenAddress, 50);
            if (!success) return;
        }

        const half   = pos.amount / 2;
        const profit = half * (pos.pnl / 100);
        if (this.appState) this.appState.dailyPnL += profit;
        pos.amount = half;
        this._logPartialClose(tokenAddress, pos, 'Manual Scale 50%', profit);
    }

    async executeLiveBuy(tokenAddress, position) {
        try {
            const amt = Math.floor(CONFIG.BUY_AMOUNT_SOL * 1_000_000_000);
            const slippageBps = Math.floor(CONFIG.SLIPPAGE_SIMULATION_PCT * 100);
            const q   = await (await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenAddress}&amount=${amt}&slippageBps=${slippageBps}`)).json();
            if (!q || q.error) { this.removeAndLogPosition(tokenAddress, "No Liquidity", 0, 0); return; }
            const { swapTransaction } = await (await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quoteResponse: q, userPublicKey: this.wallet.publicKey.toString(), wrapAndUnwrapSol: true })
            })).json();
            const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
            tx.sign([this.wallet]);
            const txid = await this.connection.sendRawTransaction(tx.serialize());
            console.log(`[LIVE] ✅ BUY SUCCESS: https://solscan.io/tx/${txid}`);
            this.trackPrice(tokenAddress, position);
        } catch(e) {
            console.error(`[LIVE] ❌ Error (Buy): ${e.message}`);
            this.removeAndLogPosition(tokenAddress, "Buy Error", 0, 0);
        }
    }

    async executeLiveSell(tokenAddress, percentage = 100) {
        try {
            console.log(`[LIVE] ⏳ Ετοιμασία πώλησης (${percentage}%) για ${tokenAddress}...`);
            const mintPubkey = new PublicKey(tokenAddress);
            const accounts = await this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { mint: mintPubkey });
            
            if (accounts.value.length === 0) {
                console.log(`[LIVE] ❌ Δεν βρέθηκε token account για πώληση.`);
                return false;
            }

            const tokenAmount = accounts.value[0].account.data.parsed.info.tokenAmount.amount;
            if (tokenAmount === '0') {
                console.log(`[LIVE] ❌ Το υπόλοιπο του token είναι 0.`);
                return false;
            }

            let sellAmountStr = tokenAmount;
            if (percentage < 100) {
                const sellAmt = Math.floor(parseInt(tokenAmount, 10) * (percentage / 100));
                sellAmountStr = sellAmt.toString();
            }

            const slippageBps = Math.floor(CONFIG.SLIPPAGE_SIMULATION_PCT * 100);
            const q = await (await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${tokenAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${sellAmountStr}&slippageBps=${slippageBps}`)).json();
            
            if (!q || q.error) { 
                console.log(`[LIVE] ❌ Error στο Quote (Sell): ${q.error}`); 
                return false; 
            }

            const { swapTransaction } = await (await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quoteResponse: q, userPublicKey: this.wallet.publicKey.toString(), wrapAndUnwrapSol: true })
            })).json();

            const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
            tx.sign([this.wallet]);
            const txid = await this.connection.sendRawTransaction(tx.serialize());
            console.log(`[LIVE] 💸 ΠΩΛΗΣΗ ΕΠΙΤΥΧΗΣ: https://solscan.io/tx/${txid}`);
            return true;
        } catch (e) {
            console.error(`[LIVE] ❌ Σφάλμα Πώλησης: ${e.message}`);
            return false;
        }
    }

    removeAndLogPosition(tokenAddress, reason, finalPnl, solDelta) {
        if (!this.appState) return;
        const pos   = this.appState.activePositions.find(p => p.id === tokenAddress);
        const delta = solDelta !== undefined ? solDelta : (pos?.amount || CONFIG.BUY_AMOUNT_SOL) * (finalPnl / 100);
        this.appState.activePositions = this.appState.activePositions.filter(p => p.id !== tokenAddress);
        this.appState.tradeHistory.unshift({
            id: tokenAddress, reason, pnl: finalPnl,
            solDelta: delta, time: new Date().toLocaleTimeString()
        });
        if (this.appState.tradeHistory.length > 50) this.appState.tradeHistory.pop();
    }
}
