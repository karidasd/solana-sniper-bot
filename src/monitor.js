import { Connection, PublicKey } from '@solana/web3.js';

const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Rate limiter — αποφεύγουμε 429s από το Helius
const recentTokens = new Set();

export class TokenMonitor {
    constructor(rpcUrl, wssUrl) {
        this.connection = new Connection(rpcUrl, {
            wsEndpoint: wssUrl,
        });
        this.subscriptionId = null;
        console.log("[MONITOR] ✅ Initialized. Connecting to Solana via Helius...");
    }

    startMonitoring(onNewTokenCallback) {
        console.log(`[MONITOR] 🚀 LIVE SIMULATION MODE — Real Pump.fun launches only`);
        console.log(`[MONITOR] 📄 Paper Trading ON — 0 SOL risk, 100% real market prices`);
        console.log(`[MONITOR] 📡 Listening for new token launches on Pump.fun...`);

        // ── LIVE WebSocket ─────────────────────────────────────────────────
        try {
            this.subscriptionId = this.connection.onLogs(
                PUMP_FUN_PROGRAM_ID,
                async (logs, ctx) => {
                    if (logs.err) return;

                    // Ψάχνουμε για Create event του pump.fun
                    const isCreate = logs.logs && logs.logs.some(log =>
                        log.includes("InitializeMint") ||
                        log.includes("Program log: Create") ||
                        log.includes("Instruction: Create") ||
                        log.includes("create")
                    );
                    if (!isCreate) return;

                    // Εξάγουμε mint address κατευθείαν από το log string
                    // Format: "Program log: Create: <mint_address>"
                    let mintAddress = null;

                    // Μέθοδος 1: Από log strings
                    for (const log of (logs.logs || [])) {
                        const match = log.match(/Create:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
                        if (match) {
                            mintAddress = match[1];
                            break;
                        }
                    }

                    // Μέθοδος 2: Parse transaction για mint
                    if (!mintAddress) {
                        try {
                            const tx = await this.connection.getParsedTransaction(
                                logs.signature,
                                { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
                            );
                            if (tx?.meta?.postTokenBalances) {
                                const tb = tx.meta.postTokenBalances.find(
                                    b => b.mint && b.mint !== 'So11111111111111111111111111111111111111112'
                                );
                                if (tb?.mint) mintAddress = tb.mint;
                            }
                            // Μέθοδος 3: Από innerInstructions
                            if (!mintAddress && tx?.meta?.innerInstructions) {
                                for (const inner of tx.meta.innerInstructions) {
                                    for (const ix of (inner.instructions || [])) {
                                        if (ix.parsed?.type === 'initializeMint' && ix.parsed?.info?.mint) {
                                            mintAddress = ix.parsed.info.mint;
                                            break;
                                        }
                                    }
                                    if (mintAddress) break;
                                }
                            }
                        } catch (e) { /* αθόρυβη αποτυχία */ }
                    }

                    if (!mintAddress) return;
                    if (recentTokens.has(mintAddress)) return;
                    recentTokens.add(mintAddress);
                    if (recentTokens.size > 300) recentTokens.clear();

                    console.log(`\n[LIVE] 🎯 ΝΕΟΣ LAUNCH: ${mintAddress.substring(0, 16)}...`);
                    onNewTokenCallback(mintAddress);
                },
                "confirmed"
            );
            console.log(`[MONITOR] ✅ WebSocket ΕΝΕΡΓΟ — Αναμένω launches...`);
        } catch (e) {
            console.log(`[MONITOR] ❌ WebSocket failed: ${e.message}`);
        }
    }

    stopMonitoring() {
        if (this.subscriptionId !== null) {
            this.connection.removeOnLogsListener(this.subscriptionId);
            this.subscriptionId = null;
        }
        recentTokens.clear();
        console.log("[MONITOR] 🛑 Monitoring stopped.");
    }
}
