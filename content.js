// X 一键举报助手 — content script
// 在 X/Twitter 评论区自动查找并举报包含指定关键词的评论（举报类别：垃圾信息）
// 纯全自动模式：自动滚动加载更多评论 + 自动走完举报流程 + 人性化随机间隔
(() => {
  'use strict';

  // ---------- 常量 ----------
  const DEFAULT_SETTINGS = {
    keywords: ['福不黑'],
    intervalSec: 4,        // 每条举报之间的基础间隔（秒），实际会加随机抖动
    maxReports: 0,         // 0 = 不限条数
    scrollDelayMs: 1500,   // 滚动后等待评论加载的时间
  };
  const MAX_SCROLLS_PER_RUN = 80;      // 单次运行最多滚动次数，防止无限滚动
  const MAX_STEP_WAIT_MS = 8000;       // 每个步骤等待超时
  const MAX_FAILED_PER_RUN = 10;       // 单次运行累计失败上限
  const COOLDOWN_PATTERNS = [
    /太快|太频繁|操作过于频繁|请稍后|try again|too (fast|quick|frequently)|rate limit|cooldown|冷却/i,
  ];

  // ---------- 状态 ----------
  let running = false;
  let stopRequested = false;
  let runCount = 0;          // 本次运行已成功举报
  let runSkipped = 0;        // 本次运行跳过（已举报过）
  let runFailed = 0;         // 本次运行失败
  let reportedThisRun = new Set(); // 本次运行已处理的 handle（内存去重）
  let log = [];
  let runId = 0;

  // ---------- 工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs = MAX_STEP_WAIT_MS, stepMs = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  function logMsg(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    log.push(line);
    if (log.length > 60) log.shift();
    broadcastState();
  }

  // 单条举报流程内、步骤之间的随机停顿（模拟真人手速，避免连点过快）
  const humanPause = () => sleep(400 + Math.random() * 500);

  // 模拟真实鼠标点击：X 的 React 菜单项对纯 .click() 可能无响应，需要完整事件序列
  function nativeClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function byText(sel, text) {
    return [...document.querySelectorAll(sel)].find(
      (el) => (el.textContent || '').trim() === text
    );
  }

  // ---------- 识别 ----------
  function extractHandle(article) {
    const link = article.querySelector(
      'a[href^="/"]:not([href*="/status/"])'
    );
    if (!link) return null;
    const m = link.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,15})$/);
    return m ? m[1] : null;
  }

  async function getReported() {
    try {
      const { reported } = await chrome.storage.local.get('reported');
      return Array.isArray(reported) ? reported : [];
    } catch { return []; }
  }

  async function isGloballyReported(handle) {
    const r = await getReported();
    return r.includes(handle);
  }

  async function markReported(handle) {
    const r = await getReported();
    if (!r.includes(handle)) {
      r.push(handle);
      await chrome.storage.local.set({ reported: r });
    }
  }

  async function findCandidates(keywords) {
    const arts = [...document.querySelectorAll('article')];
    const out = [];
    for (const a of arts) {
      const text = a.innerText || '';
      if (!keywords.some((k) => text.includes(k))) continue;
      const handle = extractHandle(a);
      if (!handle) continue;
      if (reportedThisRun.has(handle)) continue;
      if (await isGloballyReported(handle)) continue;
      out.push(a);
    }
    return out;
  }

  // 找出评论卡片中的"更多"按钮（...）
  function findMoreButton(article) {
    const btn = [...article.querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') || '').includes('更多')
    ) || article.querySelector('[data-testid="caret"]');
    return btn || null;
  }

  // ---------- 举报流程 ----------
  // 返回 { ok: true } 或 { ok: false, reason, cooldown? }
  async function reportOne(article, handle) {
    // 1. 打开"更多"菜单
    const moreBtn = findMoreButton(article);
    if (!moreBtn) return { ok: false, reason: 'no-more-button' };
    await humanPause();
    nativeClick(moreBtn);

    const reportItem = await waitFor(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(
        (el) => (el.textContent || '').includes('举报')
      );
      return item && !item.textContent.includes('请求社群附注') ? item : null;
    });
    if (!reportItem) {
      closeAnyDialog();
      return { ok: false, reason: 'no-report-menuitem' };
    }
    await humanPause();
    nativeClick(reportItem);

    // 2. 等待举报对话框，选择"垃圾信息"
    // X 的举报类别是 label 包裹的隐藏 input[type=radio]，点击 label 即可选中
    const radioLabel = await waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      return [...dialog.querySelectorAll('label')].find((l) =>
        (l.textContent || '').includes('垃圾信息')
      );
    });
    if (!radioLabel) {
      // 可能弹出了别的对话框（如风控提示）
      const cd = detectCooldown();
      closeAnyDialog();
      return { ok: false, reason: cd ? 'cooldown' : 'no-radio', cooldown: !!cd };
    }
    await humanPause();
    nativeClick(radioLabel);
    await sleep(300);

    // 3. 下一步
    const nextBtn = byText('[role="button"]', '下一步');
    if (!nextBtn) {
      closeAnyDialog();
      return { ok: false, reason: 'no-next-button' };
    }
    await humanPause();
    nativeClick(nextBtn);

    // 4. 等待提交成功（"完成"按钮出现）
    const done = await waitFor(() => byText('[role="button"]', '完成'));
    if (!done) {
      const cd = detectCooldown();
      closeAnyDialog();
      return { ok: false, reason: cd ? 'cooldown' : 'no-done', cooldown: !!cd };
    }
    await humanPause();
    nativeClick(done);
    await sleep(400);
    return { ok: true };
  }

  function detectCooldown() {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const text = dialog.innerText || '';
    return COOLDOWN_PATTERNS.some((re) => re.test(text));
  }

  // 关闭当前打开的对话框/菜单（点击"关闭"按钮或按 Esc）
  function closeAnyDialog() {
    const closeBtn = document.querySelector(
      '[role="dialog"] [aria-label="关闭"], [role="dialog"] button[aria-label*="关闭"]'
    );
    if (closeBtn) {
      nativeClick(closeBtn);
      return;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  // ---------- 滚动加载 ----------
  async function scrollForMore(settings) {
    const before = document.querySelectorAll('article').length;
    window.scrollBy(0, window.innerHeight * 0.9);
    await sleep(settings.scrollDelayMs || DEFAULT_SETTINGS.scrollDelayMs);
    const after = document.querySelectorAll('article').length;
    return after > before;
  }

  // ---------- 主循环 ----------
  async function run(settings) {
    runId++;
    const myRun = runId;
    runCount = 0;
    runSkipped = 0;
    runFailed = 0;
    reportedThisRun = new Set();
    log = [];
    running = true;
    stopRequested = false;
    logMsg('▶ 开始自动举报（关键词：' + settings.keywords.join('、') + '）');

    let scrolls = 0;
    let noNewCount = 0;

    while (running && myRun === runId) {
      if (stopRequested) {
        running = false;
        logMsg('⏹ 已手动停止');
        break;
      }
      if (settings.maxReports > 0 && runCount >= settings.maxReports) {
        running = false;
        logMsg(`✅ 已达到上限 ${settings.maxReports} 条，结束`);
        break;
      }
      if (runFailed >= MAX_FAILED_PER_RUN) {
        running = false;
        logMsg('⚠ 失败次数过多，停止（可能被风控或页面结构变化）');
        break;
      }

      const candidates = await findCandidates(settings.keywords);
      const target = candidates[0];

      if (!target) {
        // 没有候选：尝试滚动加载更多
        if (scrolls >= MAX_SCROLLS_PER_RUN) {
          running = false;
          logMsg('🏁 已滚动到底部，本次运行结束');
          break;
        }
        const loaded = await scrollForMore(settings);
        scrolls++;
        if (!loaded) noNewCount++;
        else noNewCount = 0;
        if (noNewCount >= 4) {
          running = false;
          logMsg('🏁 没有更多新评论，本次运行结束');
          break;
        }
        continue;
      }

      const handle = extractHandle(target);
      // 滚动到该评论位置，确保菜单可点
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(600);

      const res = await reportOne(target, handle);
      if (res.ok) {
        runCount++;
        if (handle) {
          reportedThisRun.add(handle);
          await markReported(handle);
        }
        logMsg(`✅ 已举报 ${handle || '(未知)'}（累计 ${runCount} 条）`);
      } else if (res.cooldown) {
        running = false;
        logMsg('⏳ 触发举报频率限制（CD），自动停止。建议过几分钟再运行。');
        break;
      } else {
        runFailed++;
        if (handle) reportedThisRun.add(handle); // 失败也跳过，避免死循环
        logMsg(`⚠ 举报失败：${res.reason}（${handle || '未知'}，累计失败 ${runFailed}）`);
      }

      // 人性化间隔 + 随机抖动
      const jitter = Math.random() * 3;
      const delay = (settings.intervalSec || DEFAULT_SETTINGS.intervalSec) * 1000 + jitter * 1000;
      await sleep(delay);
    }

    if (running) {
      running = false;
      logMsg(`🏁 运行结束：成功 ${runCount} 条，跳过 ${runSkipped} 条，失败 ${runFailed} 条`);
    }
    broadcastState();
  }

  // ---------- 状态广播 ----------
  async function getState() {
    return {
      running,
      count: runCount,
      skipped: runSkipped,
      failed: runFailed,
      log: [...log],
      reported: await getReported(),
    };
  }

  async function broadcastState() {
    try {
      const state = await getState();
      chrome.runtime.sendMessage({ type: 'xspam-state', state }).catch(() => {});
    } catch { /* popup 未打开时忽略 */ }
  }

  // ---------- 消息入口 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'xspam-start') {
      const settings = { ...DEFAULT_SETTINGS, ...(msg.settings || {}) };
      if (!running) run(settings);
      sendResponse({ ok: true, running });
    } else if (msg && msg.type === 'xspam-stop') {
      stopRequested = true;
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'xspam-get-state') {
      getState().then((state) => sendResponse({ ok: true, state }));
      return true; // 异步响应
    } else if (msg && msg.type === 'xspam-clear-reported') {
      chrome.storage.local.remove('reported').then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  // 页面加载完成时通知 popup 当前状态
  broadcastState();
})();
