import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from './config.js';

// Pump.fun program addresses — είναι trusted mint authorities για bonding curve tokens
const PUMP_FUN_PROGRAMS = new Set([
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun main program
    'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',  // Pump.fun fee program
    'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1', // Pump.fun migration
]);

export class SafetyChecker {
    constructor(rpcUrl) {
        this.connection = new Connection(rpcUrl);
        this.solPriceUsd = 150; // Default, ανανεώνεται
        this.fetchSolPrice();
        setInterval(() => this.fetchSolPrice(), 60000);
    }

    async fetchSolPrice() {
        try {
            const r = await fetch('https://price.jup.ag/v4/price?ids=SOL');
            const d = await r.json();
            this.solPriceUsd = d?.data?.SOL?.price || this.solPriceUsd;
        } catch(e) {}
    }

    // Pump.fun API — διαθέσιμο ΑΜΕΣΩΣ μόλις δημιουργηθεί token
    async getPumpFunData(mintAddress) {
        try {
            const r = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress}`);
            if (!r.ok) return null;
            return await r.json();
        } catch(e) { return null; }
    }

    async isTokenSafe(tokenAddress) {
        try {
            console.log(`[SAFETY] 🔍 ${tokenAddress.substring(0,8)}...`);

            // ── ΕΛΕΓΧΟΣ 1: On-Chain Mint & Freeze Authority ───────────────
            let isPumpFunToken = false;
            try {
                const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(tokenAddress));
                if (!mintInfo?.value) {
                    console.log(`[SAFETY] ⚠️ On-chain read failed. Proceeding to API checks...`);
                } else {
                    const info = mintInfo.value.data?.parsed?.info;
                    if (info) {
                        const mintAuth    = info.mintAuthority;
                        const freezeAuth  = info.freezeAuthority;

                        // Αν το mintAuthority είναι pump.fun program → είναι bonding curve token (OK)
                        if (mintAuth !== null && PUMP_FUN_PROGRAMS.has(mintAuth)) {
                            isPumpFunToken = true;
                            console.log(`[SAFETY] 🟡 Pump.fun bonding curve token (mint auth = pump.fun). OK.`);
                        } else if (mintAuth !== null) {
                            // Άγνωστη mint authority → rug risk
                            console.log(`[SAFETY] 🔴 Mint Authority άγνωστο (${mintAuth?.substring(0,8)}). RUG RISK! BLOCK!`);
                            return false;
                        }

                        // Freeze Authority είναι πάντα κακό (honeypot)
                        if (freezeAuth !== null && !PUMP_FUN_PROGRAMS.has(freezeAuth)) {
                            console.log(`[SAFETY] 🔴 Freeze Authority ενεργό! HONEYPOT! BLOCK!`);
                            return false;
                        }

                        console.log(`[SAFETY] 🟢 On-chain OK. PumpFun: ${isPumpFunToken}`);
                    }
                }
            } catch(onChainErr) {
                console.log(`[SAFETY] ⚠️ On-chain check error: ${onChainErr.message}. Continuing...`);
            }

            // ── ΕΛΕΓΧΟΣ 2: Pump.fun API (άμεσα δεδομένα) ─────────────────
            const pumpData = await this.getPumpFunData(tokenAddress);

            if (pumpData && pumpData.usd_market_cap !== undefined) {
                const mcUsd        = pumpData.usd_market_cap || 0;
                const solInCurve   = (pumpData.sol_in_bonding_curve || 0) / 1e9; // lamports → SOL
                const liquidityUsd = solInCurve * this.solPriceUsd;
                const complete     = pumpData.complete || false; // graduated to Raydium

                console.log(`[SAFETY] 🏦 MC: $${mcUsd.toLocaleString()} | Liquidity(SOL in curve): $${liquidityUsd.toFixed(0)}`);
                console.log(`[SAFETY] 🎓 Graduated: ${complete}`);

                if (mcUsd < CONFIG.MIN_MARKET_CAP_USD) {
                    console.log(`[SAFETY] 🔴 MC πολύ χαμηλό. BLOCK!`); return false;
                }
                if (CONFIG.MAX_MARKET_CAP_USD < 999999998 && mcUsd > CONFIG.MAX_MARKET_CAP_USD) {
                    console.log(`[SAFETY] 🔴 MC πολύ υψηλό ($${(mcUsd/1000).toFixed(0)}K). BLOCK!`); return false;
                }
                if (liquidityUsd < CONFIG.MIN_LIQUIDITY_USD && !complete) {
                    console.log(`[SAFETY] 🔴 Χαμηλή ρευστότητα. BLOCK!`); return false;
                }
                if (CONFIG.REQUIRE_SOCIALS && !pumpData.twitter && !pumpData.telegram && !pumpData.website) {
                    console.log(`[SAFETY] 🔴 Δεν υπάρχουν socials. BLOCK!`); return false;
                }

                console.log(`[SAFETY] ✅ PASS (Pump.fun) — ${pumpData.symbol || '?'} | $${mcUsd.toFixed(0)} MC`);
                return true;
            }

            // ── ΕΛΕΓΧΟΣ 3: Fallback στο DexScreener (για graduated tokens) ─
            const dsRes  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
            const dsData = await dsRes.json();

            if (!dsData?.pairs?.length) {
                console.log(`[SAFETY] 🔴 Δεν βρέθηκε πουθενά. BLOCK!`); return false;
            }

            const best = dsData.pairs
                .filter(p => p.priceUsd && parseFloat(p.priceUsd) > 0)
                .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

            if (!best) { console.log(`[SAFETY] 🔴 Δεν βρέθηκε pair. BLOCK!`); return false; }

            const liquidityUsd = best.liquidity?.usd || 0;
            const volume5m     = best.volume?.m5     || 0;
            const mcUsd        = best.marketCap      || best.fdv || 0;

            if (liquidityUsd < CONFIG.MIN_LIQUIDITY_USD) {
                console.log(`[SAFETY] 🔴 Ανεπαρκής ρευστότητα. BLOCK!`); return false;
            }
            if (volume5m < CONFIG.MIN_VOLUME_5M_USD) {
                console.log(`[SAFETY] 🔴 Χαμηλό volume. BLOCK!`); return false;
            }

            console.log(`[SAFETY] ✅ PASS (DexScreener) | Liq: $${liquidityUsd.toFixed(0)} | Vol5m: $${volume5m.toFixed(0)}`);
            return true;

        } catch (error) {
            console.log(`[SAFETY] 🔴 Error: ${error.message}. BLOCK!`);
            return false;
        }
    }
}
