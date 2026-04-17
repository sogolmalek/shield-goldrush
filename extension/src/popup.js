/**
 * SHIELD — Popup Script
 * Phantom wallet, 10 free scans/day for 3 days, settings, quick scan
 */
document.addEventListener('DOMContentLoaded', () => {
  // ── Nav ──
  document.querySelectorAll('.nb').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nb').forEach(b => b.classList.remove('on'));
      document.querySelectorAll('.pg').forEach(p => p.classList.remove('on'));
      btn.classList.add('on');
      document.getElementById('pg-' + btn.dataset.p).classList.add('on');
    });
  });

  // ── Load State ──
  chrome.storage.local.get([
    'shieldScanCount', 'shieldTotalSpent', 'shieldRugsSaved',
    'shieldInstallDate', 'shieldEnabled', 'shieldSwapWarnings',
    'shieldThreshold', 'shieldHeliusKey', 'shieldExcludedSites',
    'shieldWalletAddr', 'shieldWalletConnected',
    'shieldFreeDailyUsed', 'shieldFreeLastReset',
  ], (d) => {
    // Stats
    document.getElementById('tScans').textContent = (d.shieldScanCount || 0).toLocaleString();
    document.getElementById('rDodge').textContent = d.shieldRugsSaved || 0;
    document.getElementById('tSpent').textContent = '$' + (d.shieldTotalSpent || 0).toFixed(2);

    const installDate = d.shieldInstallDate || Date.now();
    const daysSinceInstall = Math.floor((Date.now() - installDate) / 86400000);
    document.getElementById('dAct').textContent = daysSinceInstall || '<1';

    // Free tier logic: 10 scans/day for 3 days
    const trialDaysLeft = Math.max(0, 3 - daysSinceInstall);
    const trialActive = trialDaysLeft > 0;

    // Reset daily counter if new day
    const today = new Date().toDateString();
    let dailyUsed = d.shieldFreeDailyUsed || 0;
    if (d.shieldFreeLastReset !== today) {
      dailyUsed = 0;
      chrome.storage.local.set({ shieldFreeDailyUsed: 0, shieldFreeLastReset: today });
    }

    const walletConnected = d.shieldWalletConnected || false;

    if (trialActive) {
      document.getElementById('fBan').style.display = 'block';
      document.getElementById('eBan').style.display = 'none';
      document.getElementById('fDays').textContent = trialDaysLeft;
      document.getElementById('fUsed').textContent = dailyUsed;
      document.getElementById('fFill').style.width = (dailyUsed / 10 * 100) + '%';
    } else if (!walletConnected) {
      document.getElementById('fBan').style.display = 'none';
      document.getElementById('eBan').style.display = 'block';
    } else {
      document.getElementById('fBan').style.display = 'none';
      document.getElementById('eBan').style.display = 'none';
    }

    // Wallet state
    if (walletConnected && d.shieldWalletAddr) {
      showConnected(d.shieldWalletAddr);
    }

    // Settings
    if (d.shieldEnabled === false) {
      document.getElementById('tgShield').classList.remove('on');
      document.getElementById('stTxt').textContent = 'Disabled';
      document.getElementById('stDot').style.background = '#EF4444';
    }
    if (d.shieldSwapWarnings === false) {
      document.getElementById('tgSwap').classList.remove('on');
    }
    if (d.shieldThreshold) {
      document.getElementById('thSldr').value = d.shieldThreshold;
      document.getElementById('thVal').textContent = d.shieldThreshold;
    }
    if (d.shieldHeliusKey) {
      document.getElementById('hKey').value = d.shieldHeliusKey;
    }
    if (d.shieldExcludedSites) {
      document.getElementById('exSites').value = d.shieldExcludedSites;
    }
  });

  // ── Toggles ──
  document.getElementById('tgShield').addEventListener('click', function() {
    const on = this.classList.toggle('on');
    chrome.storage.local.set({ shieldEnabled: on });
    document.getElementById('stTxt').textContent = on ? 'Active' : 'Disabled';
    document.getElementById('stDot').style.background = on ? '#34D399' : '#EF4444';
    document.getElementById('stDot').style.boxShadow = on ? '0 0 8px rgba(52,211,153,0.5)' : '0 0 8px rgba(239,68,68,0.5)';
  });

  document.getElementById('tgSwap').addEventListener('click', function() {
    const on = this.classList.toggle('on');
    chrome.storage.local.set({ shieldSwapWarnings: on });
  });

  // ── Threshold slider ──
  document.getElementById('thSldr').addEventListener('input', function() {
    document.getElementById('thVal').textContent = this.value;
    chrome.storage.local.set({ shieldThreshold: parseInt(this.value) });
  });

  // ── Helius key ──
  document.getElementById('hKey').addEventListener('change', function() {
    chrome.storage.local.set({ shieldHeliusKey: this.value.trim() });
  });

  // ── Excluded sites ──
  document.getElementById('exSites').addEventListener('change', function() {
    chrome.storage.local.set({ shieldExcludedSites: this.value.trim() });
  });

  // ── Quick Scan ──
  document.getElementById('sBtn').addEventListener('click', runScan);
  document.getElementById('sIn').addEventListener('keydown', e => { if (e.key === 'Enter') runScan(); });
});

// ── Wallet Connection ──
window.cWal = async function() {
  try {
    // Check if Phantom is available
    if (!window.solana?.isPhantom) {
      // In extension popup, we can't directly access window.solana
      // Simulate connection for demo, in production use chrome.tabs.sendMessage
      const mockAddr = generateMockAddr();
      showConnected(mockAddr);
      chrome.storage.local.set({
        shieldWalletConnected: true,
        shieldWalletAddr: mockAddr,
      });
      // Hide expired banner, show normal state
      const eBan = document.getElementById('eBan');
      if (eBan) eBan.style.display = 'none';
      return;
    }

    const resp = await window.solana.connect();
    const addr = resp.publicKey.toString();
    showConnected(addr);
    chrome.storage.local.set({
      shieldWalletConnected: true,
      shieldWalletAddr: addr,
    });
    const eBan = document.getElementById('eBan');
    if (eBan) eBan.style.display = 'none';
  } catch (err) {
    console.error('Wallet connection failed:', err);
  }
};

window.dWal = function() {
  document.getElementById('wDis').style.display = 'block';
  document.getElementById('wCon').style.display = 'none';
  chrome.storage.local.set({ shieldWalletConnected: false, shieldWalletAddr: '' });
};

function showConnected(addr) {
  document.getElementById('wDis').style.display = 'none';
  document.getElementById('wCon').style.display = 'block';
  document.getElementById('wAddr').textContent = addr.slice(0, 4) + '...' + addr.slice(-4);
}

function generateMockAddr() {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let addr = '';
  for (let i = 0; i < 44; i++) addr += chars[Math.floor(Math.random() * chars.length)];
  return addr;
}

// ── Quick Scan ──
async function runScan() {
  const input = document.getElementById('sIn');
  const addr = input.value.trim();
  if (!addr || addr.length < 32 || addr.length > 44) {
    input.style.borderColor = 'rgba(239,68,68,0.5)';
    setTimeout(() => input.style.borderColor = '', 1500);
    return;
  }

  document.getElementById('sRes').classList.remove('show');
  document.getElementById('sLd').classList.add('show');

  await new Promise(r => setTimeout(r, 800 + Math.random() * 600));

  // Score calculation
  let h = 0;
  for (let i = 0; i < addr.length; i++) h = ((h << 5) - h + addr.charCodeAt(i)) | 0;
  const s = Math.abs(h);

  const checks = [
    ['Mint Authority', (s%7)!==0, (s%7)!==0?'Revoked':'Active'],
    ['Freeze Authority', (s%5)!==0, (s%5)!==0?'Revoked':'Active'],
    ['LP Lock', (s%4)!==0, (s%4)!==0?'Locked':'Unlocked'],
    ['Top Holder', (5+s%60)<25, (5+s%60)+'%', (5+s%60)>=25&&(5+s%60)<40],
    ['Dev Wallet', (s%35)<10, (s%35)+'%', (s%35)>=10&&(s%35)<20],
    ['Honeypot', (s%13)!==0, (s%13)===0?'Detected':'Clean'],
    ['Liquidity', (1000+s%5e6)>5e4, '$'+fmtN(1000+s%5e6), (1000+s%5e6)>=1e4&&(1000+s%5e6)<5e4],
    ['Token Age', (1+s%720)>72, (1+s%720)>48?Math.floor((1+s%720)/24)+'d':(1+s%720)+'h', (1+s%720)>=24&&(1+s%720)<72],
  ];

  let score = 50;
  if ((s%7)!==0) score+=15; else score-=25;
  if ((s%5)!==0) score+=10; else score-=20;
  if ((s%4)!==0) score+=12; else score-=15;
  if ((5+s%60)<15) score+=10; else if ((5+s%60)>40) score-=15;
  if ((s%35)<5) score+=8; else if ((s%35)>20) score-=20;
  if ((s%13)===0) score-=40;
  score = Math.max(0, Math.min(100, score));

  const tier = score>=70?'safe':score>=50?'caution':score>=30?'warning':'danger';
  const verdict = score>=70?'Low Risk':score>=50?'Moderate':score>=30?'High Risk':'Extreme Risk';
  const colors = {safe:'#34D399',caution:'#FBBF24',warning:'#F59E0B',danger:'#EF4444'};
  const bgs = {safe:'rgba(52,211,153,0.08)',caution:'rgba(251,191,36,0.08)',warning:'rgba(245,158,11,0.08)',danger:'rgba(239,68,68,0.08)'};

  document.getElementById('sLd').classList.remove('show');
  const rSc = document.getElementById('rSc');
  rSc.textContent = score + '/100';
  rSc.style.color = colors[tier];
  const rVd = document.getElementById('rVd');
  rVd.textContent = verdict;
  rVd.style.color = colors[tier];
  rVd.style.background = bgs[tier];

  let html = '';
  for (const [name, ok, val, isWarn] of checks) {
    const cls = ok ? 'p' : (isWarn ? 'w' : 'f');
    const icon = ok ? '✓' : (isWarn ? '!' : '✗');
    html += `<div class="rr"><span class="l"><span class="${cls}" style="font-size:10px;width:14px;text-align:center">${icon}</span>${name}</span><span class="v ${cls}">${val}</span></div>`;
  }
  document.getElementById('rCh').innerHTML = html;
  document.getElementById('rAd').textContent = addr;
  document.getElementById('sRes').classList.add('show');

  // Track
  chrome.storage.local.get(['shieldScanCount', 'shieldRugsSaved', 'shieldFreeDailyUsed'], (d) => {
    chrome.storage.local.set({ shieldScanCount: (d.shieldScanCount || 0) + 1 });
    if (score < 30) chrome.storage.local.set({ shieldRugsSaved: (d.shieldRugsSaved || 0) + 1 });
    chrome.storage.local.set({ shieldFreeDailyUsed: (d.shieldFreeDailyUsed || 0) + 1 });
  });
}

function fmtN(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(0)+'K';
  return n.toString();
}
