/**
 * SHIELD — Background Service Worker
 * Free tier: 10 scans/day for 3 days. Then x402 at $0.01/scan.
 */

const COST_PER_SCAN = 0.01;
const FREE_SCANS_PER_DAY = 10;
const FREE_TRIAL_DAYS = 3;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    shieldEnabled: true,
    shieldSwapWarnings: true,
    shieldScanCount: 0,
    shieldTotalSpent: 0,
    shieldRugsSaved: 0,
    shieldInstallDate: Date.now(),
    shieldThreshold: 30,
    shieldWalletConnected: false,
    shieldWalletAddr: '',
    shieldHeliusKey: '',
    shieldExcludedSites: '',
    shieldFreeDailyUsed: 0,
    shieldFreeLastReset: new Date().toDateString(),
  });
  console.log('[SHIELD] ⛨ Installed — 3-day free trial started');
});

// Check if scan is allowed (free tier or wallet connected)
function canScan(callback) {
  chrome.storage.local.get([
    'shieldInstallDate', 'shieldWalletConnected',
    'shieldFreeDailyUsed', 'shieldFreeLastReset', 'shieldEnabled',
  ], (d) => {
    if (!d.shieldEnabled) return callback({ allowed: false, reason: 'disabled' });

    const daysSince = Math.floor((Date.now() - (d.shieldInstallDate || Date.now())) / 86400000);
    const trialActive = daysSince < FREE_TRIAL_DAYS;

    // Reset daily counter if new day
    const today = new Date().toDateString();
    let dailyUsed = d.shieldFreeDailyUsed || 0;
    if (d.shieldFreeLastReset !== today) {
      dailyUsed = 0;
      chrome.storage.local.set({ shieldFreeDailyUsed: 0, shieldFreeLastReset: today });
    }

    if (trialActive && dailyUsed < FREE_SCANS_PER_DAY) {
      return callback({ allowed: true, free: true, remaining: FREE_SCANS_PER_DAY - dailyUsed });
    }

    if (d.shieldWalletConnected) {
      return callback({ allowed: true, free: false, cost: COST_PER_SCAN });
    }

    return callback({ allowed: false, reason: 'trial_expired' });
  });
}

// Track a completed scan
function trackScan(wasFree) {
  chrome.storage.local.get(['shieldScanCount', 'shieldTotalSpent', 'shieldFreeDailyUsed'], (d) => {
    const updates = { shieldScanCount: (d.shieldScanCount || 0) + 1 };
    if (wasFree) {
      updates.shieldFreeDailyUsed = (d.shieldFreeDailyUsed || 0) + 1;
    } else {
      updates.shieldTotalSpent = (d.shieldTotalSpent || 0) + COST_PER_SCAN;
    }
    chrome.storage.local.set(updates);
  });
}

// Message handler
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAN_SCAN') {
    canScan(result => sendResponse(result));
    return true;
  }

  if (msg.type === 'SCAN_DONE') {
    trackScan(msg.free);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'RUG_SAVED') {
    chrome.storage.local.get(['shieldRugsSaved'], (d) => {
      chrome.storage.local.set({ shieldRugsSaved: (d.shieldRugsSaved || 0) + 1 });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'GET_STATS') {
    chrome.storage.local.get(null, (data) => sendResponse(data));
    return true;
  }

  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get([
      'shieldEnabled', 'shieldSwapWarnings', 'shieldThreshold',
      'shieldHeliusKey', 'shieldExcludedSites',
    ], (data) => sendResponse(data));
    return true;
  }
});
