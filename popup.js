// X 一键举报助手 — popup 逻辑
'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  dot: $('statusDot'),
  warn: $('warn'),
  keywords: $('keywords'),
  interval: $('interval'),
  maxReports: $('maxReports'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  statCount: $('statCount'),
  statSkipped: $('statSkipped'),
  statFailed: $('statFailed'),
  statRunning: $('statRunning'),
  log: $('log'),
  reported: $('reported'),
  reportedCount: $('reportedCount'),
  clearBtn: $('clearBtn'),
};

let state = { running: false, count: 0, skipped: 0, failed: 0, log: [], reported: [] };

// ---------- 与 content script 通信 ----------
async function sendToTab(msg) {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^(https:\/\/(x|twitter)\.com)/.test(tab.url || '')) {
    // 当前标签页不是 X（例如 popup 作为独立标签页打开时）：回退到任意 X 标签页
    const all = await chrome.tabs.query({
      url: ['https://x.com/*', 'https://twitter.com/*'],
    });
    tab = all[0];
    if (!tab) {
      els.warn.style.display = 'block';
      els.warn.textContent = '没有找到 X (x.com) 标签页，请先打开目标帖子页面。';
      return null;
    }
  }
  els.warn.style.display = 'none';
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    els.warn.style.display = 'block';
    els.warn.textContent = 'content script 未就绪，请刷新 X 页面后重试。';
    return null;
  }
}

// ---------- 渲染 ----------
function render() {
  els.dot.className = 'dot' + (state.running ? ' on' : '');
  els.statCount.textContent = state.count;
  els.statSkipped.textContent = state.skipped;
  els.statFailed.textContent = state.failed;
  els.statRunning.textContent = state.running ? '运行中' : '空闲';
  els.startBtn.disabled = state.running;
  els.stopBtn.disabled = !state.running;
  els.log.textContent = (state.log || []).join('\n');
  els.log.scrollTop = els.log.scrollHeight;
  els.reportedCount.textContent = (state.reported || []).length;
  els.reported.textContent = (state.reported || []).join(', ');
}

// ---------- 持久化设置 ----------
function saveSettings() {
  localStorage.setItem('xspam-keywords', els.keywords.value);
  localStorage.setItem('xspam-interval', els.interval.value);
  localStorage.setItem('xspam-max', els.maxReports.value);
}

function loadSettings() {
  els.keywords.value = localStorage.getItem('xspam-keywords') || '福不黑';
  els.interval.value = localStorage.getItem('xspam-interval') || '4';
  els.maxReports.value = localStorage.getItem('xspam-max') || '0';
}

// ---------- 事件 ----------
els.startBtn.addEventListener('click', async () => {
  saveSettings();
  const keywords = els.keywords.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (keywords.length === 0) {
    els.keywords.focus();
    return;
  }
  await sendToTab({
    type: 'xspam-start',
    settings: {
      keywords,
      intervalSec: Math.max(2, parseInt(els.interval.value, 10) || 4),
      maxReports: Math.max(0, parseInt(els.maxReports.value, 10) || 0),
    },
  });
  await refresh();
});

els.stopBtn.addEventListener('click', async () => {
  await sendToTab({ type: 'xspam-stop' });
  await refresh();
});

els.clearBtn.addEventListener('click', async () => {
  await sendToTab({ type: 'xspam-clear-reported' });
  await refresh();
});

async function refresh() {
  const res = await sendToTab({ type: 'xspam-get-state' });
  if (res && res.state) {
    state = res.state;
    render();
  }
}

// content script 主动推送状态
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'xspam-state' && msg.state) {
    state = msg.state;
    render();
  }
});

// ---------- 初始化 ----------
loadSettings();
refresh();
setInterval(refresh, 2000);
