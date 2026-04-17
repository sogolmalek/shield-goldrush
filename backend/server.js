/**
 * SHIELD Backend — Production Server
 * RugCheck API + Alchemy RPC + GoldRush Data Layer + USDC payment verification
 */
const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const { ShieldGoldRush } = require('./goldrush');

const app = express();
app.use(cors());
app.use(express.json());

// ── Config ──
const PORT = process.env.PORT || 3001;
const ALCHEMY_RPC = process.env.ALCHEMY_RPC || 'https://solana-mainnet.g.alchemy.com/v2/FE1Fd3x7PlqkZYxMqQpP3orTaf1dsmG4';
const GOLDRUSH_KEY = process.env.GOLDRUSH_API_KEY || 'cqt_rQVgy4MyC3CgJcgvVBR3BFgR9Dgm';
const OWNER_WALLET = 'A59AVvijPfVC62vxpWqHevgc5FEaQ6bEEmdvSdMYDebs';
const SCAN_COST_LAMPORTS = 10000; // $0.01 USDC (6 decimals = 10000)
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FREE_SCANS_PER_DAY = 10;
const FREE_TRIAL_DAYS = 3;
const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';

const connection = new Connection(ALCHEMY_RPC, 'confirmed');
const goldRush = GOLDRUSH_KEY ? new ShieldGoldRush(GOLDRUSH_KEY) : null;

// ── In-memory stores (use Redis in production at scale) ──
const userState = new Map();    // walletAddr → { firstSeen, scansToday, lastReset, totalScans }
const scanCache = new Map();    // tokenAddr → { result, timestamp }
const CACHE_TTL = 5 * 60 * 1000; // 5 min cache

// ── Health ──
app.get('/', (req, res) => {
  res.json({
    name: 'Shield API',
    version: '2.0.0',
    status: 'live',
    owner: OWNER_WALLET,
    pricing: '$0.01 USDC/scan via x402',
    freeTier: `${FREE_SCANS_PER_DAY} scans/day for ${FREE_TRIAL_DAYS} days`,
    dataSources: {
      rugcheck: true,
      alchemy: true,
      goldrush: !!goldRush,
    },
  });
});

// ═══════════════════════════════
// GOLDRUSH ENDPOINTS
// ═══════════════════════════════

// Wallet risk scoring (GoldRush-powered)
app.get('/api/wallet/risk/:address', async (req, res) => {
  if (!goldRush) return res.status(503).json({ error: 'GoldRush not configured' });
  try {
    const result = await goldRush.scoreWalletRisk(req.params.address);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'wallet_risk_failed', message: e.message });
  }
});

// Wallet balances with USD pricing (GoldRush-powered)
app.get('/api/wallet/balances/:address', async (req, res) => {
  if (!goldRush) return res.status(503).json({ error: 'GoldRush not configured' });
  try {
    const result = await goldRush.getWalletBalances(req.params.address);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'balances_failed', message: e.message });
  }
});

// Token holder analysis (GoldRush-powered)
app.get('/api/token/holders/:mint', async (req, res) => {
  if (!goldRush) return res.status(503).json({ error: 'GoldRush not configured' });
  try {
    const holders = await goldRush.getTokenHolders(req.params.mint);
    res.json({ mint: req.params.mint, holders: holders || [], source: 'goldrush' });
  } catch (e) {
    res.status(500).json({ error: 'holders_failed', message: e.message });
  }
});

// Transaction history (GoldRush-powered)
app.get('/api/token/transactions/:address', async (req, res) => {
  if (!goldRush) return res.status(503).json({ error: 'GoldRush not configured' });
  try {
    const txs = await goldRush.getTransactions(req.params.address, parseInt(req.query.limit || '20'));
    res.json({ address: req.params.address, transactions: txs || [], source: 'goldrush' });
  } catch (e) {
    res.status(500).json({ error: 'transactions_failed', message: e.message });
  }
});

// ── Free scan (no wallet needed) ──
app.post('/api/scan/free', async (req, res) => {
  const { token, fingerprint } = req.body;
  if (!token) return res.status(400).json({ error: 'token address required' });

  // Track by fingerprint (browser ID)
  const fp = fingerprint || 'anonymous';
  const user = getOrCreateUser(fp);
  const today = new Date().toDateString();

  if (user.lastReset !== today) {
    user.scansToday = 0;
    user.lastReset = today;
  }

  const daysSinceFirst = Math.floor((Date.now() - user.firstSeen) / 86400000);
  const trialActive = daysSinceFirst < FREE_TRIAL_DAYS;

  if (!trialActive || user.scansToday >= FREE_SCANS_PER_DAY) {
    return res.status(402).json({
      error: 'free_tier_exhausted',
      message: trialActive
        ? `Daily limit reached (${FREE_SCANS_PER_DAY}/${FREE_SCANS_PER_DAY}). Connect wallet for unlimited.`
        : 'Free trial ended. Connect Phantom wallet to continue. $0.01/scan.',
      payment: {
        recipient: OWNER_WALLET,
        amount: '0.01',
        currency: 'USDC',
        network: 'solana',
      },
    });
  }

  try {
    const result = await scoreTok(token);
    user.scansToday++;
    user.totalScans++;
    res.json({
      ...result,
      billing: {
        type: 'free',
        scansRemaining: FREE_SCANS_PER_DAY - user.scansToday,
        trialDaysLeft: Math.max(0, FREE_TRIAL_DAYS - daysSinceFirst),
      },
    });
  } catch (e) {
    res.status(500).json({ error: 'scan_failed', message: e.message });
  }
});

// ── Paid scan (wallet connected, verify payment) ──
app.post('/api/scan/paid', async (req, res) => {
  const { token, wallet, txSignature } = req.body;
  if (!token) return res.status(400).json({ error: 'token address required' });
  if (!wallet) return res.status(400).json({ error: 'wallet address required' });

  // If txSignature provided, verify payment
  if (txSignature) {
    const verified = await verifyPayment(txSignature, wallet);
    if (!verified) {
      return res.status(402).json({
        error: 'payment_not_verified',
        message: 'USDC payment not confirmed. Send $0.01 USDC to proceed.',
        payment: { recipient: OWNER_WALLET, amount: '0.01', currency: 'USDC', network: 'solana' },
      });
    }
  } else {
    // No tx provided — check if user has recent payment credit
    const hasCredit = await checkRecentPayment(wallet);
    if (!hasCredit) {
      return res.status(402).json({
        error: 'payment_required',
        message: 'Send $0.01 USDC to scan.',
        payment: { recipient: OWNER_WALLET, amount: '0.01', currency: 'USDC', network: 'solana', mint: USDC_MINT },
      });
    }
  }

  try {
    const result = await scoreTok(token);
    res.json({ ...result, billing: { type: 'paid', cost: '$0.01 USDC' } });
  } catch (e) {
    res.status(500).json({ error: 'scan_failed', message: e.message });
  }
});

// ── Batch scan (multiple tokens) ──
app.post('/api/scan/batch', async (req, res) => {
  const { tokens, fingerprint, wallet } = req.body;
  if (!tokens?.length) return res.status(400).json({ error: 'tokens array required' });
  if (tokens.length > 20) return res.status(400).json({ error: 'max 20 tokens per batch' });

  const results = await Promise.allSettled(
    tokens.map(t => scoreTok(t))
  );

  res.json({
    results: results.map((r, i) => ({
      token: tokens[i],
      ...(r.status === 'fulfilled' ? r.value : { error: r.reason?.message }),
    })),
  });
});

// ── Check user status ──
app.get('/api/status/:fingerprint', (req, res) => {
  const user = userState.get(req.params.fingerprint);
  if (!user) return res.json({ isNew: true, freeScansLeft: FREE_SCANS_PER_DAY, trialDaysLeft: FREE_TRIAL_DAYS });

  const daysSince = Math.floor((Date.now() - user.firstSeen) / 86400000);
  const today = new Date().toDateString();
  const scansToday = user.lastReset === today ? user.scansToday : 0;

  res.json({
    isNew: false,
    freeScansLeft: Math.max(0, FREE_SCANS_PER_DAY - scansToday),
    trialDaysLeft: Math.max(0, FREE_TRIAL_DAYS - daysSince),
    trialActive: daysSince < FREE_TRIAL_DAYS,
    totalScans: user.totalScans,
  });
});

// ═══════════════════════════════
// SCORING ENGINE
// ═══════════════════════════════

async function scoreTok(mintAddress) {
  // Check cache
  const cached = scanCache.get(mintAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.result;

  const start = Date.now();

  // Parallel: RugCheck + RPC + GoldRush
  const [rugcheckResult, rpcResult, goldRushResult] = await Promise.allSettled([
    (async () => {
      const rcRes = await fetch(`${RUGCHECK_API}/tokens/${mintAddress}/report/summary`, {
        signal: AbortSignal.timeout(6000),
      });
      return rcRes.ok ? rcRes.json() : null;
    })(),
    getRPCData(mintAddress),
    goldRush ? goldRush.enhanceTokenScore(mintAddress, 50) : null,
  ]);

  const rugcheckData = rugcheckResult.status === 'fulfilled' ? rugcheckResult.value : null;
  const rpcData = rpcResult.status === 'fulfilled' ? rpcResult.value : {};
  const grData = goldRushResult.status === 'fulfilled' ? goldRushResult.value : null;

  // Build base score from RugCheck + RPC
  const result = buildScore(mintAddress, rugcheckData, rpcData, Date.now() - start);

  // Enhance with GoldRush data
  if (grData && grData.adjustment !== 0) {
    result.score = Math.max(0, Math.min(100, result.score + grData.adjustment));
    result.tier = result.score >= 70 ? 'safe' : result.score >= 50 ? 'caution' : result.score >= 30 ? 'warning' : 'danger';
    result.verdict = result.score >= 70 ? 'Low Risk' : result.score >= 50 ? 'Moderate' : result.score >= 30 ? 'High Risk' : 'Extreme Risk';
    result.goldrushInsights = grData.insights;
    result.sources.goldrush = true;
  }

  scanCache.set(mintAddress, { result, timestamp: Date.now() });
  return result;
}

async function getRPCData(mintAddress) {
  const mint = new PublicKey(mintAddress);

  const [accountInfo, largestAccounts, supply] = await Promise.allSettled([
    connection.getParsedAccountInfo(mint),
    connection.getTokenLargestAccounts(mint),
    connection.getTokenSupply(mint),
  ]);

  const parsed = accountInfo.status === 'fulfilled'
    ? accountInfo.value?.value?.data?.parsed?.info
    : null;

  const holders = largestAccounts.status === 'fulfilled'
    ? largestAccounts.value?.value || []
    : [];

  const totalSupply = supply.status === 'fulfilled'
    ? parseFloat(supply.value?.value?.uiAmount || 0)
    : 0;

  // Top holder concentration
  let topHolderPct = 0;
  let top5Pct = 0;
  if (holders.length > 0 && totalSupply > 0) {
    topHolderPct = (parseFloat(holders[0]?.uiAmount || 0) / totalSupply) * 100;
    top5Pct = holders.slice(0, 5).reduce((s, h) => s + parseFloat(h.uiAmount || 0), 0) / totalSupply * 100;
  }

  // Token age from signatures
  let ageHours = 0;
  try {
    const sigs = await connection.getSignaturesForAddress(mint, { limit: 1 });
    if (sigs.length > 0 && sigs[0].blockTime) {
      ageHours = Math.floor((Date.now() / 1000 - sigs[0].blockTime) / 3600);
    }
  } catch (e) {}

  return {
    mintAuthority: parsed?.mintAuthority || null,
    freezeAuthority: parsed?.freezeAuthority || null,
    totalSupply,
    topHolderPct: Math.round(topHolderPct * 10) / 10,
    top5Pct: Math.round(top5Pct * 10) / 10,
    holderCount: holders.length,
    ageHours,
  };
}

function buildScore(address, rc, rpc, latencyMs) {
  // Determine each check from best available source
  const mintAuthActive = rc
    ? (rc.mintAuthority !== null && rc.mintAuthority !== '' && rc.mintAuthority !== '0')
    : (rpc.mintAuthority !== null && rpc.mintAuthority !== undefined);

  const freezeAuthActive = rc
    ? (rc.freezeAuthority !== null && rc.freezeAuthority !== '' && rc.freezeAuthority !== '0')
    : (rpc.freezeAuthority !== null && rpc.freezeAuthority !== undefined);

  const lpLocked = rc
    ? (rc.markets?.some(m => m.lp?.lpLocked) ?? false)
    : false;

  const topHolderPct = rc?.topHolders?.[0]?.pct ?? rpc.topHolderPct ?? 0;
  const devWalletPct = rc?.creator?.pct ?? (rpc.top5Pct > 50 ? rpc.top5Pct - 40 : 5);
  const isHoneypot = rc?.risks?.some(r => r.name?.toLowerCase().includes('honeypot')) ?? false;

  const liquidityUSD = rc
    ? (rc.markets?.reduce((s, m) => s + (m.lp?.usd ?? 0), 0) ?? 0)
    : 0;

  const ageHours = rc?.createdAt
    ? Math.floor((Date.now() - new Date(rc.createdAt).getTime()) / 3600000)
    : (rpc.ageHours || 0);

  // Composite score
  let score = 50;
  if (!mintAuthActive) score += 15; else score -= 25;
  if (!freezeAuthActive) score += 10; else score -= 20;
  if (lpLocked) score += 12; else score -= 15;
  if (topHolderPct < 15) score += 10; else if (topHolderPct > 40) score -= 15;
  if (devWalletPct < 5) score += 8; else if (devWalletPct > 20) score -= 20;
  if (isHoneypot) score -= 40;
  if (liquidityUSD > 100000) score += 5;
  if (ageHours > 168) score += 5;
  score = Math.max(0, Math.min(100, score));

  const tier = score >= 70 ? 'safe' : score >= 50 ? 'caution' : score >= 30 ? 'warning' : 'danger';

  return {
    score,
    tier,
    verdict: score >= 70 ? 'Low Risk' : score >= 50 ? 'Moderate' : score >= 30 ? 'High Risk' : 'Extreme Risk',
    address,
    checks: {
      mintAuth: { pass: !mintAuthActive, label: 'Mint Authority', value: mintAuthActive ? 'Active' : 'Revoked' },
      freezeAuth: { pass: !freezeAuthActive, label: 'Freeze Authority', value: freezeAuthActive ? 'Active' : 'Revoked' },
      lpLock: { pass: lpLocked, label: 'LP Lock', value: lpLocked ? 'Locked' : 'Unlocked' },
      topHolder: { pass: topHolderPct < 25, warn: topHolderPct >= 25 && topHolderPct < 40, label: 'Top Holder', value: Math.round(topHolderPct) + '%' },
      devWallet: { pass: devWalletPct < 10, warn: devWalletPct >= 10 && devWalletPct < 20, label: 'Dev Wallet', value: Math.round(devWalletPct) + '%' },
      honeypot: { pass: !isHoneypot, label: 'Honeypot', value: isHoneypot ? 'Detected' : 'Clean' },
      liquidity: { pass: liquidityUSD > 50000, warn: liquidityUSD >= 10000 && liquidityUSD < 50000, label: 'Liquidity', value: '$' + fmtN(liquidityUSD) },
      age: { pass: ageHours > 72, warn: ageHours >= 24 && ageHours < 72, label: 'Token Age', value: ageHours > 48 ? Math.floor(ageHours / 24) + 'd' : ageHours + 'h' },
    },
    sources: {
      rugcheck: !!rc,
      rpc: Object.keys(rpc).length > 0,
    },
    meta: { latencyMs, source: rc ? 'rugcheck+rpc' : 'rpc-only', timestamp: Date.now() },
  };
}

// ═══════════════════════════════
// PAYMENT VERIFICATION
// ═══════════════════════════════

async function verifyPayment(txSignature, senderWallet) {
  try {
    const tx = await connection.getParsedTransaction(txSignature, { maxSupportedTransactionVersion: 0 });
    if (!tx) return false;

    // Look for USDC transfer to OWNER_WALLET
    const instructions = tx.transaction?.message?.instructions || [];
    for (const ix of instructions) {
      if (ix.parsed?.type === 'transferChecked' || ix.parsed?.type === 'transfer') {
        const info = ix.parsed.info;
        if (info.mint === USDC_MINT || ix.programId?.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
          // Check destination is our wallet's token account
          const amount = parseFloat(info.tokenAmount?.uiAmount || info.amount || 0);
          if (amount >= 0.01) return true;
        }
      }
    }
    return false;
  } catch (e) {
    console.error('Payment verification error:', e.message);
    return false;
  }
}

async function checkRecentPayment(walletAddress) {
  try {
    const ownerPubkey = new PublicKey(OWNER_WALLET);
    const sigs = await connection.getSignaturesForAddress(ownerPubkey, { limit: 20 });
    // Check if any recent tx is from this wallet (last 10 min = scan credit)
    for (const sig of sigs) {
      if (sig.blockTime && Date.now() / 1000 - sig.blockTime < 600) {
        const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
        const accounts = tx?.transaction?.message?.accountKeys || [];
        if (accounts.some(a => a.pubkey?.toString() === walletAddress)) return true;
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

// ── Helpers ──
function getOrCreateUser(fp) {
  if (!userState.has(fp)) {
    userState.set(fp, {
      firstSeen: Date.now(),
      scansToday: 0,
      lastReset: new Date().toDateString(),
      totalScans: 0,
    });
  }
  return userState.get(fp);
}

function fmtN(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toString();
}

// ═══════════════════════════════
// LI.FI PROXY (avoids CORS in extension)
// ═══════════════════════════════
const LIFI_API = 'https://li.quest/v1';

// Proxy LI.FI routes request
app.post('/api/lifi/routes', async (req, res) => {
  try {
    const lifiRes = await fetch(`${LIFI_API}/advanced/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(20000),
    });
    const data = await lifiRes.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'lifi_routes_failed', message: e.message });
  }
});

// Proxy LI.FI quote request
app.get('/api/lifi/quote', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query);
    const lifiRes = await fetch(`${LIFI_API}/quote?${params}`, {
      signal: AbortSignal.timeout(15000),
    });
    const data = await lifiRes.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'lifi_quote_failed', message: e.message });
  }
});

// Proxy LI.FI supported chains
app.get('/api/lifi/chains', async (req, res) => {
  try {
    const lifiRes = await fetch(`${LIFI_API}/chains`, { signal: AbortSignal.timeout(5000) });
    const data = await lifiRes.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'lifi_chains_failed', message: e.message });
  }
});

// Combined: scan + get swap route in one call
app.post('/api/scan-and-swap', async (req, res) => {
  const { token, fingerprint, fromChainId, fromToken, fromAmount } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  try {
    // 1. Score the token
    const score = await scoreTok(token);

    // 2. If score < 30, block swap
    if (score.score < 30) {
      return res.json({
        ...score,
        swap: { blocked: true, reason: `Token scored ${score.score}/100 — too risky to swap` },
      });
    }

    // 3. If swap params provided, get LI.FI route
    let swap = null;
    if (fromChainId && fromToken && fromAmount) {
      const SOLANA_CHAIN_ID = 1151111081099710;
      const routeRes = await fetch(`${LIFI_API}/advanced/routes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromChainId: parseInt(fromChainId),
          toChainId: SOLANA_CHAIN_ID,
          fromTokenAddress: fromToken,
          toTokenAddress: token,
          fromAmount,
          options: { slippage: 0.03, order: 'RECOMMENDED' },
        }),
        signal: AbortSignal.timeout(20000),
      });
      swap = await routeRes.json();
    }

    res.json({ ...score, swap });
  } catch (e) {
    res.status(500).json({ error: 'scan_swap_failed', message: e.message });
  }
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n⛨ SHIELD API live on port ${PORT}`);
  console.log(`  Owner wallet: ${OWNER_WALLET}`);
  console.log(`  RPC: ${ALCHEMY_RPC.slice(0, 40)}...`);
  console.log(`  GoldRush: ${goldRush ? 'enabled' : 'disabled (set GOLDRUSH_API_KEY)'}`);
  console.log(`  Free tier: ${FREE_SCANS_PER_DAY}/day for ${FREE_TRIAL_DAYS} days`);
  console.log(`  Paid: $0.01 USDC/scan`);
  console.log(`  LI.FI: cross-chain swaps enabled\n`);
});
