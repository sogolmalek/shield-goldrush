/**
 * SHIELD — Production Content Script
 * Calls Shield backend for real RugCheck + RPC scoring
 */
(() => {
  'use strict';

  const SHIELD_API = 'https://shield-api.onrender.com'; // UPDATE after deploy
  const SOLANA_ADDR_RE = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
  const SKIP_ADDRS = new Set([
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'So11111111111111111111111111111111111111112',
    'ComputeBudget111111111111111111111111111111',
    'Vote111111111111111111111111111111111111111',
    'Stake11111111111111111111111111111111111111',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  ]);

  const cache = new Map();
  const processed = new WeakSet();
  let fingerprint = localStorage.getItem('shield_fp') || (Math.random().toString(36).slice(2) + Date.now().toString(36));
  localStorage.setItem('shield_fp', fingerprint);

  // ── API Call ──
  async function scan(address) {
    if (cache.has(address)) return cache.get(address);

    // Try free scan first
    let res = await fetch(`${SHIELD_API}/api/scan/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: address, fingerprint }),
    });

    // 402 = free tier exhausted, try paid
    if (res.status === 402) {
      const walletAddr = await getWalletFromStorage();
      if (!walletAddr) {
        return { score: -1, blocked: true, reason: 'wallet_required' };
      }
      res = await fetch(`${SHIELD_API}/api/scan/paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: address, wallet: walletAddr }),
      });
      if (res.status === 402) {
        return { score: -1, blocked: true, reason: 'payment_required' };
      }
    }

    if (!res.ok) throw new Error('Scan failed');
    const data = await res.json();
    cache.set(address, data);
    return data;
  }

  function getWalletFromStorage() {
    return new Promise(r => {
      try { chrome.storage?.local?.get(['shieldWalletAddr'], d => r(d.shieldWalletAddr || null)); }
      catch(e) { r(null); }
    });
  }

  // ── Badge ──
  const COLORS = { safe: '#34D399', caution: '#FBBF24', warning: '#F59E0B', danger: '#EF4444' };
  const BGS = { safe: 'rgba(52,211,153,0.1)', caution: 'rgba(251,191,36,0.1)', warning: 'rgba(245,158,11,0.1)', danger: 'rgba(239,68,68,0.1)' };

  function makeBadge(data) {
    const b = document.createElement('span');
    b.className = `shield-badge shield-${data.tier}`;
    b.textContent = data.score;

    const tip = document.createElement('div');
    tip.className = 'shield-tooltip';
    let checksHTML = '';
    for (const [, c] of Object.entries(data.checks || {})) {
      const cls = c.pass ? 'pass' : (c.warn ? 'warn' : 'fail');
      const ico = c.pass ? '✓' : (c.warn ? '!' : '✗');
      checksHTML += `<div class="shield-check-row"><span class="check-name"><span class="check-icon check-result ${cls}">${ico}</span>${c.label}</span><span class="check-result ${cls}">${c.value}</span></div>`;
    }
    tip.innerHTML = `
      <div class="shield-tooltip-header">
        <div><div class="shield-tooltip-label">Shield Score</div><div class="shield-tooltip-score" style="color:${COLORS[data.tier]}">${data.score}/100</div></div>
        <div class="shield-tooltip-verdict" style="color:${COLORS[data.tier]};background:${BGS[data.tier]}">${data.verdict}</div>
      </div>
      <div class="shield-tooltip-checks">${checksHTML}</div>
      <div class="shield-tooltip-buy">
        <button class="shield-buy-btn ${data.score < 30 ? 'shield-buy-blocked' : ''}" data-token="${data.address}" data-score="${data.score}" data-tier="${data.tier}" data-verdict="${data.verdict}">
          ${data.score < 30 ? '🛑 Blocked' : '⚡ Buy Safe via LI.FI'}
        </button>
      </div>
      <div class="shield-tooltip-footer">
        <span class="shield-logo-text">⛨ SHIELD</span>
        <span>LI.FI cross-chain · $0.01</span>
      </div>`;

    // Attach buy button handler
    const buyBtn = tip.querySelector('.shield-buy-btn');
    if (buyBtn) {
      buyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const token = buyBtn.dataset.token;
        const score = parseInt(buyBtn.dataset.score);
        const tier = buyBtn.dataset.tier;
        const verdict = buyBtn.dataset.verdict;
        if (globalThis.ShieldLifi?.createSwapModal) {
          globalThis.ShieldLifi.createSwapModal(token, score, tier, verdict);
        }
      });
    }

    b.appendChild(tip);
    return b;
  }

  // ── Scanner ──
  function validAddr(a) { return a.length >= 32 && a.length <= 44 && !SKIP_ADDRS.has(a) && !/[0OIl]/.test(a); }

  function scanNode(tn) {
    if (processed.has(tn)) return;
    const txt = tn.textContent;
    if (!txt || txt.length < 32) return;
    const p = tn.parentElement;
    if (!p) return;
    const tag = p.tagName?.toLowerCase();
    if (['script','style','textarea','input','noscript','code','pre'].includes(tag)) return;
    if (p.closest?.('.shield-badge,.shield-tooltip')) return;
    if (p.isContentEditable) return;

    const matches = [...txt.matchAll(SOLANA_ADDR_RE)].filter(m => validAddr(m[1]));
    if (!matches.length) return;
    processed.add(tn);

    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of matches) {
      if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
      const sp = document.createElement('span');
      sp.textContent = txt.slice(m.index, m.index + m[0].length);
      frag.appendChild(sp);

      const dot = document.createElement('span');
      dot.className = 'shield-badge shield-loading';
      dot.textContent = '···';
      frag.appendChild(dot);

      scan(m[1]).then(r => {
        if (r.blocked) { dot.remove(); return; }
        dot.replaceWith(makeBadge(r));
      }).catch(() => dot.remove());

      last = m.index + m[0].length;
    }
    if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
    p.replaceChild(frag, tn);
  }

  function scanEl(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.textContent?.length >= 32 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    const nodes = []; let n;
    while ((n = w.nextNode())) nodes.push(n);
    let i = 0;
    (function batch() {
      const end = Math.min(i + 8, nodes.length);
      for (; i < end; i++) scanNode(nodes[i]);
      if (i < nodes.length) (requestIdleCallback || setTimeout)(batch);
    })();
  }

  // ── Swap Warning ──
  function checkSwap() {
    const u = location.href;
    if (!u.includes('jup.ag') && !u.includes('jupiter.ag') && !u.includes('raydium.io')) return;
    const mint = new URLSearchParams(location.search).get('outputMint');
    if (mint && validAddr(mint)) {
      scan(mint).then(r => {
        if (r.score >= 0 && r.score < 40 && !document.querySelector('.shield-swap-overlay')) {
          const el = document.createElement('div');
          el.className = 'shield-swap-overlay';
          el.innerHTML = `<span class="shield-alert-icon">⛨</span><span><strong>SHIELD:</strong> Score ${r.score}/100 — ${r.verdict}.</span><button class="shield-close-btn" onclick="this.parentElement.remove()">Dismiss</button>`;
          document.body.prepend(el);
        }
      });
    }
  }

  // ── Init ──
  function init() {
    try {
      chrome.storage?.local?.get(['shieldEnabled','shieldExcludedSites'], d => {
        if (d.shieldEnabled === false) return;
        const ex = (d.shieldExcludedSites||'').split('\n').filter(Boolean);
        if (ex.some(s => location.hostname.includes(s))) return;
        go();
      });
    } catch(e) { go(); }
  }

  function go() {
    scanEl(document.body);
    checkSwap();
    new MutationObserver(ms => {
      for (const m of ms) for (const n of m.addedNodes)
        if (n.nodeType === 1 && !n.closest?.('.shield-badge')) scanEl(n);
    }).observe(document.body, { childList: true, subtree: true });
    let lu = location.href;
    setInterval(() => { if (location.href !== lu) { lu = location.href; checkSwap(); } }, 1000);
    console.log('[SHIELD] ⛨ Live — real scoring via RugCheck + Alchemy RPC');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
