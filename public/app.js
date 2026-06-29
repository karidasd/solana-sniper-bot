// ─── UI References ─────────────────────────────────────────────────────────
const startBtn          = document.getElementById('startBtn');
const stopBtn           = document.getElementById('stopBtn');
const logOutput         = document.getElementById('logOutput');
const botStatusBadge    = document.getElementById('botStatusBadge');
const connectionDot     = document.getElementById('connectionDot');
const modeIndicator     = document.getElementById('modeIndicator');
const dailyPnlDisplay   = document.getElementById('daily-pnl');
const walletDisplay     = document.getElementById('wallet-balance');
const tradeCountDisplay = document.getElementById('trade-count');
const winRateDisplay    = document.getElementById('win-rate');
const positionsTbody    = document.getElementById('positions-tbody');
const historyTbody      = document.getElementById('history-tbody');
const positionsCount    = document.getElementById('positions-count');
const historyCount      = document.getElementById('history-count');
const statOpen          = document.getElementById('stat-open');
const statClosed        = document.getElementById('stat-closed');
const statBest          = document.getElementById('stat-best');
const statWorst         = document.getElementById('stat-worst');
const dexIframe         = document.getElementById('dex-iframe');
const chartTitleEl      = document.getElementById('chart-title');
const soundSnipe        = document.getElementById('sound-snipe');
const soundProfit       = document.getElementById('sound-profit');

// ─── Auth ──────────────────────────────────────────────────────────────────
function getAdminPassword() { return localStorage.getItem('adminPassword') || ''; }
function promptForPassword() {
    const pwd = prompt("Enter Admin Password to perform this action:");
    if (pwd) {
        localStorage.setItem('adminPassword', pwd);
        updateLoginBtn();
        return pwd;
    }
    return null;
}
function updateLoginBtn() {
    const loginBtn = document.getElementById('loginBtn');
    if (!loginBtn) return;
    if (localStorage.getItem('adminPassword')) {
        loginBtn.textContent = '🔒 Logout';
        loginBtn.style.color = 'var(--green)';
    } else {
        loginBtn.textContent = '🔑 Login';
        loginBtn.style.color = 'var(--text-primary)';
    }
}
document.getElementById('loginBtn')?.addEventListener('click', () => {
    if (localStorage.getItem('adminPassword')) {
        localStorage.removeItem('adminPassword');
        updateLoginBtn();
        showToast('Logged out.', 'info');
    } else {
        promptForPassword();
    }
});
updateLoginBtn();

async function authFetch(url, options = {}) {
    let pwd = getAdminPassword();
    if (!pwd) {
        pwd = promptForPassword();
        if (!pwd) return { ok: false, status: 401, json: async () => ({ success: false, message: 'Password required' }) };
    }
    if (!options.headers) options.headers = {};
    options.headers['Authorization'] = pwd;
    
    const res = await fetch(url, options);
    if (res.status === 401) {
        showToast('❌ Wrong Password!', 'loss');
        localStorage.removeItem('adminPassword');
        updateLoginBtn();
        return { ok: false, status: 401, json: async () => ({ success: false, message: 'Wrong password' }) };
    }
    return res;
}

// ─── State ─────────────────────────────────────────────────────────────────
let isRunning          = false;
let prevPnL            = 0;
let currentChartToken  = 'So11111111111111111111111111111111111111112';
let userSelectedChart  = false;   // true = ο χρήστης έχει κάνει click σε token
let knownPositionIds   = new Set();
let lastLogCount       = 0;

// ─── Toast ─────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'info') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className   = `toast ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast hidden'; }, 3500);
}

// ─── Terminal ──────────────────────────────────────────────────────────────
function appendLog(msg, type = '') {
    const div  = document.createElement('div');
    div.className = 'log-line';
    const time = new Date().toLocaleTimeString();
    div.innerHTML = `<span class="log-time">[${time}]</span> <span class="${type}">${msg}</span>`;
    logOutput.appendChild(div);
    logOutput.scrollTop = logOutput.scrollHeight;
    while (logOutput.children.length > 250) logOutput.removeChild(logOutput.firstChild);
}
function clearLogs() {
    logOutput.innerHTML = '';
    appendLog('Terminal cleared.', 'text-blue');
}

// ─── Chart ─────────────────────────────────────────────────────────────────
function setChartToken(tokenId, label, tabEl) {
    userSelectedChart = true;
    currentChartToken = tokenId;
    dexIframe.src = `https://dexscreener.com/solana/${tokenId}?embed=1&theme=dark&trades=0&info=0`;
    chartTitleEl.textContent = `📊 ${label}`;
    document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
    if (tabEl) tabEl.classList.add('active');
}
// Χρησιμοποιείται από κλικ σε token link — κλειδώνει το chart
function updateChart(tokenId) {
    userSelectedChart = true;
    if (currentChartToken === tokenId) return;
    currentChartToken = tokenId;
    dexIframe.src = `https://dexscreener.com/solana/${tokenId}?embed=1&theme=dark&trades=0&info=0`;
    chartTitleEl.textContent = `📊 ${tokenId.substring(0, 8)}...`;
    document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
}
// Χρησιμοποιείται από τον polling — αλλάζει ΜΟΝΟ αν ο χρήστης δεν έχει επιλέξει
function autoUpdateChart(tokenId) {
    if (userSelectedChart) return;  // ο χρήστης έχει κάνει επιλογή → μην αλλάξεις
    if (currentChartToken === tokenId) return;
    currentChartToken = tokenId;
    dexIframe.src = `https://dexscreener.com/solana/${tokenId}?embed=1&theme=dark&trades=0&info=0`;
    chartTitleEl.textContent = `📊 ${tokenId.substring(0, 8)}...`;
}

// ─── Positions ─────────────────────────────────────────────────────────────
function renderPositions(positions) {
    positionsCount.textContent = positions.length;
    statOpen.textContent       = positions.length;

    if (positions.length === 0) {
        positionsTbody.innerHTML = '<tr><td colspan="6" class="empty-state">No open positions. Start the bot to begin sniping.</td></tr>';
        knownPositionIds.clear();
        return;
    }

    let hasNew = false;
    positions.forEach(p => {
        if (!knownPositionIds.has(p.id)) { hasNew = true; knownPositionIds.add(p.id); }
    });
    const currentIds = new Set(positions.map(p => p.id));
    knownPositionIds.forEach(id => { if (!currentIds.has(id)) knownPositionIds.delete(id); });

    if (hasNew) {
        soundSnipe.currentTime = 0;
        soundSnipe.play().catch(() => {});
        showToast('🎯 New position opened!', 'info');
        // Αυτόματο chart ΜΟΝΟ για νέο position ΚΑΙ μόνο αν ο χρήστης δεν έχει επιλέξει
        if (positions.length > 0) autoUpdateChart(positions[0].id);
    }

    // Χτίζουμε τον πίνακα — ενημερώνουμε in-place αν το row ήδη υπάρχει
    const existingRows = {};
    positionsTbody.querySelectorAll('tr[data-pos-id]').forEach(row => {
        existingRows[row.dataset.posId] = row;
    });

    const currentPosIds = positions.map(p => p.id);

    // Αφαιρούμε rows που δεν υπάρχουν πια
    Object.keys(existingRows).forEach(id => {
        if (!currentPosIds.includes(id)) existingRows[id].remove();
    });

    positions.forEach((pos, idx) => {
        const shortId  = pos.id.substring(0, 6) + '…' + pos.id.slice(-4);
        const pnlClass = pos.pnl > 0 ? 'positive' : (pos.pnl < 0 ? 'negative' : 'neutral');
        const pnlSign  = pos.pnl > 0 ? '+' : '';
        const maxPnl   = pos.maxPnl ?? 0;
        const entryFmt = pos.entryPrice ? `$${pos.entryPrice.toExponential(3)}` : '—';
        const barW     = Math.min(100, Math.max(0, pos.pnl + 25)) + '%';
        const barColor = pos.pnl >= 0 ? 'var(--green)' : 'var(--red)';
        const tp1Badge = pos.tp1Hit ? '<span style="color:var(--green);font-size:0.65rem;">TP1✓</span> ' : '';
        const tp2Badge = pos.tp2Hit ? '<span style="color:var(--accent);font-size:0.65rem;">TP2✓</span> ' : '';

        if (existingRows[pos.id]) {
            // ── Ενημέρωση in-place (χωρίς re-render ολόκληρης σειράς) ──
            const row = existingRows[pos.id];
            const pnlSpan = row.querySelector('.pos-pnl');
            if (pnlSpan) { pnlSpan.textContent = `${pnlSign}${pos.pnl.toFixed(2)}%`; pnlSpan.className = `pos-pnl ${pnlClass}`; }
            const barFill = row.querySelector('.pnl-bar-fill');
            if (barFill) { barFill.style.width = barW; barFill.style.background = barColor; }
            const peakTd = row.querySelector('.peak-td');
            if (peakTd) peakTd.innerHTML = `${tp1Badge}${tp2Badge}+${maxPnl.toFixed(1)}%`;
        } else {
            // ── Νέα σειρά ──
            const tr = document.createElement('tr');
            tr.className = 'new-row';
            tr.dataset.posId = pos.id;
            tr.innerHTML = `
                <td><a class="token-link" onclick="updateChart('${pos.id}')" title="${pos.id}">${shortId}</a></td>
                <td>${pos.amount.toFixed(3)}</td>
                <td style="color:var(--text-muted);font-size:0.72rem;">${entryFmt}</td>
                <td>
                    <div class="pnl-bar-wrap">
                        <span class="pos-pnl ${pnlClass}">${pnlSign}${pos.pnl.toFixed(2)}%</span>
                        <div class="pnl-bar"><div class="pnl-bar-fill" style="width:${barW};background:${barColor};"></div></div>
                    </div>
                </td>
                <td class="pos-pnl peak-td ${maxPnl > 0 ? 'positive' : 'neutral'}">${tp1Badge}${tp2Badge}+${maxPnl.toFixed(1)}%</td>
                <td>
                    <button class="btn btn-scale" onclick="sellHalf('${pos.id}')">50%</button>
                    <button class="btn btn-panic" onclick="panicSell('${pos.id}')">🚨</button>
                </td>`;
            positionsTbody.appendChild(tr);
        }
    });

    if (positions.length === 0) {
        positionsTbody.innerHTML = '<tr><td colspan="6" class="empty-state">No open positions. Start the bot to begin sniping.</td></tr>';
    }
}

// ─── History ───────────────────────────────────────────────────────────────
function renderHistory(history) {
    historyCount.textContent = history.length;
    statClosed.textContent   = history.length;

    if (history.length === 0) {
        historyTbody.innerHTML = '<tr><td colspan="5" class="empty-state">No closed trades yet.</td></tr>';
        return;
    }

    const pnls   = history.map(t => t.pnl).filter(p => p !== undefined);
    const wins   = pnls.filter(p => p > 0).length;
    const winPct = pnls.length > 0 ? Math.round((wins / pnls.length) * 100) : null;
    winRateDisplay.textContent = winPct !== null ? `${winPct}%` : '—';
    winRateDisplay.className   = `stat-value ${winPct !== null && winPct >= 50 ? 'positive' : 'negative'}`;
    tradeCountDisplay.textContent = history.length;

    const best  = pnls.length > 0 ? Math.max(...pnls) : null;
    const worst = pnls.length > 0 ? Math.min(...pnls) : null;
    statBest.textContent  = best  !== null ? `+${best.toFixed(1)}%`  : '—';
    statWorst.textContent = worst !== null ? `${worst.toFixed(1)}%` : '—';

    let html = '';
    history.forEach(trade => {
        const shortId  = trade.id.substring(0, 6) + '…' + trade.id.slice(-4);
        const pnlClass = trade.pnl > 0 ? 'positive' : (trade.pnl < 0 ? 'negative' : 'neutral');
        const pnlSign  = trade.pnl > 0 ? '+' : '';
        const solDelta = trade.solDelta !== undefined
            ? `<span class="${trade.solDelta >= 0 ? 'positive' : 'negative'}">${trade.solDelta >= 0 ? '+' : ''}${trade.solDelta.toFixed(4)}</span>`
            : '—';
        html += `<tr>
            <td><a class="token-link" onclick="updateChart('${trade.id}')" title="${trade.id}">${shortId}</a></td>
            <td class="pos-reason">${trade.reason}</td>
            <td class="pos-pnl ${pnlClass}">${pnlSign}${trade.pnl.toFixed(2)}%</td>
            <td>${solDelta}</td>
            <td style="color:var(--text-muted);font-size:0.72rem;">${trade.time}</td>
        </tr>`;
    });
    historyTbody.innerHTML = html;
}

// ─── Status Poll ───────────────────────────────────────────────────────────
async function updateStatus() {
    try {
        const data = await fetch('/api/status').then(r => r.json());
        isRunning = data.isRunning;
        updateButtons();

        // Sync inputs
        if (!document.activeElement.matches('input')) {
            const c = data.config;
            document.getElementById('buyAmount').value           = c.BUY_AMOUNT_SOL;
            document.getElementById('maxCapital').value          = c.MAX_CAPITAL_SOL;
            document.getElementById('takeProfit1').value         = c.TAKE_PROFIT_1_PCT;
            document.getElementById('takeProfit2').value         = c.TAKE_PROFIT_2_PCT;
            document.getElementById('stopLoss').value            = c.STOP_LOSS_PERCENTAGE;
            document.getElementById('trailingStopLoss').value    = c.TRAILING_STOP_LOSS_PERCENTAGE;
            document.getElementById('trailingActivateAt').value  = c.TRAILING_ACTIVATE_AT_PCT;
            document.getElementById('autoSellTimeoutSec').value  = c.AUTO_SELL_TIMEOUT_SEC;
            document.getElementById('entryDelaySec').value       = c.ENTRY_DELAY_SEC;
            document.getElementById('minLiquidity').value        = c.MIN_LIQUIDITY_USD;
            document.getElementById('minVolume5m').value         = c.MIN_VOLUME_5M_USD;
            document.getElementById('minMarketCap').value        = c.MIN_MARKET_CAP_USD;
            document.getElementById('maxMarketCap').value        = c.MAX_MARKET_CAP_USD;
            document.getElementById('maxPumpPct').value          = c.MAX_PUMP_PCT;
            document.getElementById('slippagePct').value         = c.SLIPPAGE_SIMULATION_PCT;
            document.getElementById('paperTrading').checked      = c.PAPER_TRADING;
            document.getElementById('requireSocials').checked    = c.REQUIRE_SOCIALS;
        }

        // Mode indicator
        const isPaper = data.config.PAPER_TRADING;
        modeIndicator.textContent = isPaper ? '📄 PAPER' : '🔴 LIVE';
        modeIndicator.classList.toggle('live', !isPaper);

        // Capital
        const capDisplay = document.getElementById('capital-display');
        if (capDisplay && data.maxCapital !== undefined) {
            const dep = data.deployedCapital || 0;
            const max = data.maxCapital;
            const pct = max > 0 ? (dep / max) * 100 : 0;
            capDisplay.textContent = `${dep.toFixed(3)} / ${max} SOL`;
            capDisplay.className   = pct >= 90 ? 'stat-value negative' : (pct >= 50 ? 'stat-value accent-text' : 'stat-value positive');
        }

        // PnL
        const pnl     = data.dailyPnL || 0;
        const pnlDiff = pnl - prevPnL;
        dailyPnlDisplay.textContent = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`;
        dailyPnlDisplay.className   = `stat-value ${pnl > 0 ? 'positive' : (pnl < 0 ? 'negative' : 'neutral')}`;

        if (pnlDiff > 0.0001 && prevPnL !== 0) {
            soundProfit.currentTime = 0;
            soundProfit.play().catch(() => {});
            showToast(`💰 +${pnlDiff.toFixed(4)} SOL profit!`, 'profit');
        } else if (pnlDiff < -0.0001 && prevPnL !== 0) {
            showToast(`📉 ${pnlDiff.toFixed(4)} SOL loss`, 'loss');
        }
        prevPnL = pnl;

        walletDisplay.textContent = `${(data.walletBalance || 0).toFixed(4)} SOL`;
        renderPositions(data.activePositions || []);
        renderHistory(data.tradeHistory || []);

    } catch (e) {
        botStatusBadge.textContent = 'DISCONNECTED';
        botStatusBadge.className   = 'status-badge';
        connectionDot.className    = 'pulse-dot';
    }
}

// ─── Server Logs Poll ──────────────────────────────────────────────────────
async function fetchLogs() {
    try {
        const data = await fetch('/api/logs').then(r => r.json());
        const logs = data.logs || [];
        if (logs.length < lastLogCount) lastLogCount = 0;
        for (let i = lastLogCount; i < logs.length; i++) {
            const m = logs[i].msg;
            let cls = '';
            if (m.includes('✅') || m.includes('🟢') || m.includes('📈') || m.includes('TP'))   cls = 'text-green';
            else if (m.includes('🔴') || m.includes('❌') || m.includes('📉') || m.includes('🚨')) cls = 'text-red';
            else if (m.includes('⚡') || m.includes('🎯') || m.includes('⚠️') || m.includes('⏳')) cls = 'text-yellow';
            else if (m.includes('[LIVE]') || m.includes('[TRACK]') || m.includes('[ENTRY]'))     cls = 'text-purple';
            else if (m.includes('[CAPITAL]') || m.includes('[SAFETY]'))                          cls = 'text-blue';
            appendLog(m, cls);
        }
        lastLogCount = logs.length;
    } catch(e) {}
}

// ─── Buttons ───────────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
    startBtn.disabled = true; startBtn.textContent = '⏳ Starting...';
    const res = await authFetch('/api/start', { method: 'POST' });
    if (!res.ok) { updateStatus(); return; }
    appendLog('▶ Bot started — Monitoring Pump.fun for new tokens...', 'text-green');
    showToast('🚀 Sniper Online!', 'info');
    updateStatus();
});

stopBtn.addEventListener('click', async () => {
    const res = await authFetch('/api/stop', { method: 'POST' });
    if (!res.ok) return;
    appendLog('■ Bot stopped.', 'text-red');
    showToast('🛑 Bot stopped.', 'loss');
    updateStatus();
});

document.getElementById('saveConfigBtn').addEventListener('click', async () => {
    const config = {
        buyAmount:          document.getElementById('buyAmount').value,
        maxCapital:         document.getElementById('maxCapital').value,
        takeProfit1:        document.getElementById('takeProfit1').value,
        takeProfit2:        document.getElementById('takeProfit2').value,
        stopLoss:           document.getElementById('stopLoss').value,
        trailingStopLoss:   document.getElementById('trailingStopLoss').value,
        trailingActivateAt: document.getElementById('trailingActivateAt').value,
        autoSellTimeoutSec: document.getElementById('autoSellTimeoutSec').value,
        entryDelaySec:      document.getElementById('entryDelaySec').value,
        minLiquidity:       document.getElementById('minLiquidity').value,
        minVolume5m:        document.getElementById('minVolume5m').value,
        minMarketCap:       document.getElementById('minMarketCap').value,
        maxMarketCap:       document.getElementById('maxMarketCap').value,
        maxPumpPct:         document.getElementById('maxPumpPct').value,
        slippagePct:        document.getElementById('slippagePct').value,
        paperTrading:       document.getElementById('paperTrading').checked,
        requireSocials:     document.getElementById('requireSocials').checked,
    };
    const res = await authFetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    });
    const d = await res.json();
    if (d.success) { appendLog('⚙️ Configuration saved.', 'text-yellow'); showToast('✅ Config saved!', 'info'); }
});

async function panicSell(tokenAddress) {
    const res = await authFetch('/api/panic-sell', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tokenAddress }) });
    if (res.ok) appendLog(`🚨 PANIC SELL: ${tokenAddress.substring(0,8)}...`, 'text-red');
}
async function sellHalf(tokenAddress) {
    const res = await authFetch('/api/sell-half', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tokenAddress }) });
    if (res.ok) appendLog(`⚖️ Scale-out 50%: ${tokenAddress.substring(0,8)}...`, 'text-yellow');
}

function updateButtons() {
    if (isRunning) {
        startBtn.disabled = true; startBtn.textContent = '▶ START';
        stopBtn.disabled  = false;
        botStatusBadge.textContent = 'ONLINE'; botStatusBadge.className = 'status-badge online';
        connectionDot.className = 'pulse-dot online';
    } else {
        startBtn.disabled = false; startBtn.textContent = '▶ START';
        stopBtn.disabled  = true;
        botStatusBadge.textContent = 'OFFLINE'; botStatusBadge.className = 'status-badge';
        connectionDot.className = 'pulse-dot';
    }
}

// ─── Polling ───────────────────────────────────────────────────────────────
setInterval(updateStatus, 1500);
setInterval(fetchLogs,    1000);
updateStatus();
fetchLogs();
