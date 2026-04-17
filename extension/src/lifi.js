/**
 * SHIELD × LI.FI — Cross-Chain Safe Swap
 * "See score → Buy safe → From any chain"
 */
(() => {
  'use strict';

  const LIFI_API = 'https://li.quest/v1';
  const SOLANA_CHAIN_ID = 1151111081099710; // LI.FI Solana chain ID

  // Supported source chains for cross-chain swaps
  const SOURCE_CHAINS = [
    { id: 1, name: 'Ethereum', icon: '⟠', nativeCurrency: 'ETH' },
    { id: 42161, name: 'Arbitrum', icon: '🔵', nativeCurrency: 'ETH' },
    { id: 8453, name: 'Base', icon: '🟦', nativeCurrency: 'ETH' },
    { id: 10, name: 'Optimism', icon: '🔴', nativeCurrency: 'ETH' },
    { id: 137, name: 'Polygon', icon: '🟣', nativeCurrency: 'MATIC' },
    { id: 56, name: 'BSC', icon: '🟡', nativeCurrency: 'BNB' },
    { id: SOLANA_CHAIN_ID, name: 'Solana', icon: '◎', nativeCurrency: 'SOL' },
  ];

  // Common stablecoins per chain (USDC addresses)
  const USDC_BY_CHAIN = {
    1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    10: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    56: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  };

  // ── LI.FI API Calls ──
  async function getQuote(fromChainId, fromToken, toToken, fromAmount, fromAddress) {
    const params = new URLSearchParams({
      fromChain: fromChainId.toString(),
      toChain: SOLANA_CHAIN_ID.toString(),
      fromToken,
      toToken,
      fromAmount,
      fromAddress: fromAddress || '0x0000000000000000000000000000000000000000',
    });

    const res = await fetch(`${LIFI_API}/quote?${params}`, {
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Quote failed');
    }
    return res.json();
  }

  async function getRoutes(fromChainId, fromToken, toToken, fromAmount, fromAddress) {
    const body = {
      fromChainId,
      toChainId: SOLANA_CHAIN_ID,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      fromAmount,
      fromAddress: fromAddress || undefined,
      options: {
        slippage: 0.03,
        order: 'RECOMMENDED',
      },
    };

    const res = await fetch(`${LIFI_API}/advanced/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error('Routes failed');
    return res.json();
  }

  async function getTokenPrice(chainId, tokenAddress) {
    try {
      const res = await fetch(`${LIFI_API}/token?chain=${chainId}&token=${tokenAddress}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  // ── Swap Modal UI ──
  function createSwapModal(tokenAddress, shieldScore, shieldTier, shieldVerdict) {
    // Block dangerous tokens
    if (shieldScore < 30) {
      showBlockedModal(tokenAddress, shieldScore, shieldVerdict);
      return;
    }

    // Remove existing modal
    document.querySelector('.shield-lifi-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'shield-lifi-overlay';

    const tierColors = { safe: '#34D399', caution: '#FBBF24', warning: '#F59E0B', danger: '#EF4444' };
    const color = tierColors[shieldTier] || '#FBBF24';

    overlay.innerHTML = `
      <div class="shield-lifi-modal">
        <div class="shield-lifi-header">
          <div class="shield-lifi-title">
            <span class="shield-lifi-logo">⛨</span>
            <span>Shield Safe Swap</span>
            <span class="shield-lifi-powered">powered by LI.FI</span>
          </div>
          <button class="shield-lifi-close" id="shieldLifiClose">✕</button>
        </div>

        <div class="shield-lifi-score-bar" style="border-left: 3px solid ${color}">
          <div class="shield-lifi-score-info">
            <span class="shield-lifi-score-label">Shield Score</span>
            <span class="shield-lifi-score-value" style="color:${color}">${shieldScore}/100 — ${shieldVerdict}</span>
          </div>
          ${shieldScore < 50 ? `<div class="shield-lifi-warning-text">⚠ Moderate risk — proceed with caution</div>` : ''}
        </div>

        <div class="shield-lifi-token-target">
          <span class="shield-lifi-label">Buying on Solana</span>
          <span class="shield-lifi-addr">${tokenAddress.slice(0, 8)}...${tokenAddress.slice(-6)}</span>
        </div>

        <div class="shield-lifi-form">
          <div class="shield-lifi-field">
            <label class="shield-lifi-label">From Chain</label>
            <select id="shieldLifiChain" class="shield-lifi-select">
              ${SOURCE_CHAINS.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('')}
            </select>
          </div>

          <div class="shield-lifi-field">
            <label class="shield-lifi-label">Pay With</label>
            <div class="shield-lifi-pay-row">
              <select id="shieldLifiPayToken" class="shield-lifi-select shield-lifi-select-sm">
                <option value="native">Native (ETH/SOL)</option>
                <option value="usdc" selected>USDC</option>
              </select>
              <input type="number" id="shieldLifiAmount" class="shield-lifi-input" placeholder="10.00" value="10" min="0.01" step="0.01" />
            </div>
          </div>

          <div id="shieldLifiQuoteBox" class="shield-lifi-quote-box" style="display:none">
            <div class="shield-lifi-quote-row">
              <span>You receive (est.)</span>
              <span id="shieldLifiReceive" class="shield-lifi-receive">—</span>
            </div>
            <div class="shield-lifi-quote-row shield-lifi-quote-detail">
              <span>Route</span>
              <span id="shieldLifiRoute">—</span>
            </div>
            <div class="shield-lifi-quote-row shield-lifi-quote-detail">
              <span>Est. time</span>
              <span id="shieldLifiTime">—</span>
            </div>
            <div class="shield-lifi-quote-row shield-lifi-quote-detail">
              <span>Fees</span>
              <span id="shieldLifiFees">—</span>
            </div>
          </div>

          <div id="shieldLifiLoading" class="shield-lifi-loading" style="display:none">
            <div class="shield-lifi-spinner"></div>
            <span>Finding best route across 20+ bridges...</span>
          </div>

          <div id="shieldLifiError" class="shield-lifi-error" style="display:none"></div>

          <button id="shieldLifiQuoteBtn" class="shield-lifi-btn shield-lifi-btn-quote">Get Quote via LI.FI</button>
          <button id="shieldLifiSwapBtn" class="shield-lifi-btn shield-lifi-btn-swap" style="display:none" disabled>Connect Wallet to Swap</button>
        </div>

        <div class="shield-lifi-footer">
          <span>⛨ Shield verifies safety</span>
          <span>·</span>
          <span>LI.FI finds best route</span>
          <span>·</span>
          <span>You approve the tx</span>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Event listeners
    document.getElementById('shieldLifiClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('shieldLifiQuoteBtn').addEventListener('click', () => {
      fetchQuote(tokenAddress);
    });

    document.getElementById('shieldLifiChain').addEventListener('change', () => {
      // Reset quote when chain changes
      document.getElementById('shieldLifiQuoteBox').style.display = 'none';
      document.getElementById('shieldLifiSwapBtn').style.display = 'none';
      document.getElementById('shieldLifiQuoteBtn').style.display = 'block';
      document.getElementById('shieldLifiError').style.display = 'none';
    });

    // Escape key
    const escHandler = e => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);
  }

  async function fetchQuote(tokenAddress) {
    const chainId = parseInt(document.getElementById('shieldLifiChain').value);
    const payType = document.getElementById('shieldLifiPayToken').value;
    const amount = parseFloat(document.getElementById('shieldLifiAmount').value);

    if (!amount || amount <= 0) {
      showError('Enter a valid amount');
      return;
    }

    // Determine from token
    let fromToken;
    let decimals;
    if (payType === 'native') {
      fromToken = chainId === SOLANA_CHAIN_ID ? 'So11111111111111111111111111111111111111112' : '0x0000000000000000000000000000000000000000';
      decimals = 18;
      if (chainId === SOLANA_CHAIN_ID) decimals = 9;
    } else {
      if (chainId === SOLANA_CHAIN_ID) {
        fromToken = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC on Solana
        decimals = 6;
      } else {
        fromToken = USDC_BY_CHAIN[chainId] || USDC_BY_CHAIN[1];
        decimals = 6;
      }
    }

    const fromAmount = BigInt(Math.floor(amount * (10 ** decimals))).toString();

    // Show loading
    document.getElementById('shieldLifiQuoteBtn').style.display = 'none';
    document.getElementById('shieldLifiLoading').style.display = 'flex';
    document.getElementById('shieldLifiError').style.display = 'none';
    document.getElementById('shieldLifiQuoteBox').style.display = 'none';

    try {
      const data = await getRoutes(chainId, fromToken, tokenAddress, fromAmount);

      if (!data.routes || data.routes.length === 0) {
        throw new Error('No routes found. Try a different chain or amount.');
      }

      const best = data.routes[0];
      const steps = best.steps || [];
      const toolNames = steps.map(s => s.toolDetails?.name || s.tool || 'Unknown').join(' → ');
      const estTime = steps.reduce((t, s) => t + (s.estimate?.executionDuration || 0), 0);
      const gasCost = best.gasCostUSD || steps.reduce((t, s) => t + parseFloat(s.estimate?.gasCosts?.[0]?.amountUSD || 0), 0);
      const toAmount = best.toAmountMin || best.toAmount || '0';
      const toDecimals = best.toToken?.decimals || 9;
      const received = (parseFloat(toAmount) / (10 ** toDecimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });

      // Show quote
      document.getElementById('shieldLifiReceive').textContent = `${received} tokens`;
      document.getElementById('shieldLifiRoute').textContent = toolNames;
      document.getElementById('shieldLifiTime').textContent = estTime > 60 ? `~${Math.ceil(estTime / 60)} min` : `~${estTime}s`;
      document.getElementById('shieldLifiFees').textContent = `~$${parseFloat(gasCost).toFixed(2)} gas`;
      document.getElementById('shieldLifiQuoteBox').style.display = 'block';
      document.getElementById('shieldLifiSwapBtn').style.display = 'block';
      document.getElementById('shieldLifiSwapBtn').textContent = 'Connect Wallet to Swap';

      // Store route for execution
      window.__shieldLifiRoute = best;

      document.getElementById('shieldLifiSwapBtn').addEventListener('click', () => executeSwap(best));

    } catch (e) {
      showError(e.message || 'Failed to get quote');
      document.getElementById('shieldLifiQuoteBtn').style.display = 'block';
    } finally {
      document.getElementById('shieldLifiLoading').style.display = 'none';
    }
  }

  async function executeSwap(route) {
    const btn = document.getElementById('shieldLifiSwapBtn');

    // Check for wallet
    if (window.solana && window.solana.isPhantom) {
      try {
        btn.textContent = 'Connecting wallet...';
        btn.disabled = true;
        const resp = await window.solana.connect();
        btn.textContent = 'Opening swap in LI.FI...';

        // Open LI.FI widget or jumper.exchange with pre-filled params
        const fromChainId = document.getElementById('shieldLifiChain').value;
        const toToken = route.toToken?.address || '';
        const jumperUrl = `https://jumper.exchange/?fromChain=${fromChainId}&toChain=${SOLANA_CHAIN_ID}&toToken=${toToken}`;
        window.open(jumperUrl, '_blank');

        btn.textContent = 'Swap opened in new tab ↗';
        setTimeout(() => { btn.textContent = 'Open LI.FI Swap Again'; btn.disabled = false; }, 3000);
      } catch (e) {
        btn.textContent = 'Wallet connection failed — try again';
        btn.disabled = false;
      }
    } else if (window.ethereum) {
      // EVM wallet
      try {
        btn.textContent = 'Connecting wallet...';
        btn.disabled = true;
        await window.ethereum.request({ method: 'eth_requestAccounts' });
        const fromChainId = document.getElementById('shieldLifiChain').value;
        const toToken = route.toToken?.address || '';
        const jumperUrl = `https://jumper.exchange/?fromChain=${fromChainId}&toChain=${SOLANA_CHAIN_ID}&toToken=${toToken}`;
        window.open(jumperUrl, '_blank');
        btn.textContent = 'Swap opened in new tab ↗';
        setTimeout(() => { btn.textContent = 'Open LI.FI Swap Again'; btn.disabled = false; }, 3000);
      } catch (e) {
        btn.textContent = 'Wallet connection failed — try again';
        btn.disabled = false;
      }
    } else {
      // No wallet — open Jumper directly
      const fromChainId = document.getElementById('shieldLifiChain').value;
      const toToken = route.toToken?.address || '';
      window.open(`https://jumper.exchange/?fromChain=${fromChainId}&toChain=${SOLANA_CHAIN_ID}&toToken=${toToken}`, '_blank');
    }
  }

  function showBlockedModal(tokenAddress, score, verdict) {
    document.querySelector('.shield-lifi-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'shield-lifi-overlay';
    overlay.innerHTML = `
      <div class="shield-lifi-modal shield-lifi-blocked">
        <div class="shield-lifi-header">
          <div class="shield-lifi-title">
            <span class="shield-lifi-logo">⛨</span>
            <span>Swap Blocked by Shield</span>
          </div>
          <button class="shield-lifi-close" onclick="this.closest('.shield-lifi-overlay').remove()">✕</button>
        </div>
        <div class="shield-lifi-blocked-content">
          <div class="shield-lifi-blocked-icon">🛑</div>
          <div class="shield-lifi-blocked-score">Score: ${score}/100</div>
          <div class="shield-lifi-blocked-verdict">${verdict}</div>
          <p class="shield-lifi-blocked-text">
            Shield has blocked this swap because this token scored below 30. 
            High risk of rug pull detected. Do not buy this token.
          </p>
          <div class="shield-lifi-blocked-addr">${tokenAddress}</div>
          <button class="shield-lifi-btn shield-lifi-btn-close" onclick="this.closest('.shield-lifi-overlay').remove()">
            I Understand — Close
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  function showError(msg) {
    const el = document.getElementById('shieldLifiError');
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
    }
  }

  // ── Export for content.js ──
  if (typeof globalThis !== 'undefined') {
    globalThis.ShieldLifi = { createSwapModal, getQuote, getRoutes };
  }
})();
