export const CONFIG = {
    // ─── Βασικές Ρυθμίσεις ────────────────────────────────────────
    USE_JITO: false,
    PRIORITY_FEE: 0,
    BUY_AMOUNT_SOL: 0.01,

    // ─── Διαχείριση Κεφαλαίου ────────────────────────────────────
    MAX_CAPITAL_SOL: 0.1,         // Μέγιστο συνολικό κεφάλαιο σε ανοιχτές θέσεις

    // ─── Exit Strategy (Expert Multi-Level) ──────────────────────
    TAKE_PROFIT_1_PCT:  50,       // TP1: Πούλα 50% της θέσης στο +50%
    TAKE_PROFIT_2_PCT: 100,       // TP2: Πούλα άλλο 50% στο +100%
    STOP_LOSS_PERCENTAGE: 25,     // Hard Stop Loss -25% (νέα tokens = υψηλή vol)
    TRAILING_STOP_LOSS_PERCENTAGE: 20,   // Trailing SL: αν πέσει 20% από peak
    TRAILING_ACTIVATE_AT_PCT: 30, // Trailing ενεργό μόνο μετά από +30%
    AUTO_SELL_TIMEOUT_SEC: 600,   // 10 λεπτά — αρκετός χρόνος για νέο token

    // ─── Entry Filters για Live Pump.fun Tokens ───────────────────
    ENTRY_DELAY_SEC: 8,            // 8 δευτερόλεπτα delay — αφήνουμε το token να "αναπνεύσει"
    MIN_LIQUIDITY_USD: 1000,       // $1.000 SOL in bonding curve (χαμηλό για νέα tokens)
    MIN_VOLUME_5M_USD: 0,          // Νέα tokens δεν έχουν 5m volume ακόμα
    MIN_MARKET_CAP_USD: 8000,      // Ελάχιστο $8K MC — αποφεύγουμε «νεκρούς» launches
    MAX_MARKET_CAP_USD: 200000,    // Μέγιστο $200K — δεν αγοράζουμε κορυφές
    MAX_PUMP_PCT: 1000,            // Επιτρέπουμε μέχρι +1000% pump (νέα tokens)
    SLIPPAGE_SIMULATION_PCT: 2.5,  // 2.5% slippage — ρεαλιστικό για νέα tokens

    // ─── Safety Filters ───────────────────────────────────────────
    REQUIRE_SOCIALS: false,

    // ─── Mode ─────────────────────────────────────────────────────
    PAPER_TRADING: true            // Paper mode — χωρίς πραγματικά SOL
};
