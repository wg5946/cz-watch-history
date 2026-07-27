// ==UserScript==
// @name         厂长资源 观影历史记录增强版
// @namespace    https://www.4kcz.com/
// @version      1.2.0
// @description  为 厂长资源 影视站增加观影历史、播放进度记录、最新集数检测、并支持从历史新窗口打开后自动跳转到上次播放时间
// @author       wg5945
// @license      MIT
// @match        *://czzyv.com/*
// @match        *://*.czzyv.com/*
// @match        *://4kcz.com/*
// @match        *://*.4kcz.com/*
// @match        *://plala.py1080p.com/*
// @match        *://*.plala.py1080p.com/*
// @match        *://py1080p.com/*
// @match        *://*.py1080p.com/*
// @match        *://159.75.162.215/*
// @match        *://*/player/*.php*
// @grant        none
// @run-at       document-end
// @downloadURL https://update.greasyfork.org/scripts/578674/%E5%8E%82%E9%95%BF%E8%B5%84%E6%BA%90%20%E8%A7%82%E5%BD%B1%E5%8E%86%E5%8F%B2%E8%AE%B0%E5%BD%95%E5%A2%9E%E5%BC%BA%E7%89%88.user.js
// @updateURL https://update.greasyfork.org/scripts/578674/%E5%8E%82%E9%95%BF%E8%B5%84%E6%BA%90%20%E8%A7%82%E5%BD%B1%E5%8E%86%E5%8F%B2%E8%AE%B0%E5%BD%95%E5%A2%9E%E5%BC%BA%E7%89%88.meta.js
// ==/UserScript==

(function () {
    'use strict';

    // 调试日志开关：默认关闭，需要排查问题时在控制台执行 localStorage.setItem('CZ_HISTORY_DEBUG','1') 后刷新
    const DEBUG = (function () {
        try { return localStorage.getItem('CZ_HISTORY_DEBUG') === '1'; } catch (e) { return false; }
    })();

    const CONFIG = {
        SITE_HOSTS: ['czzyv.com', '4kcz.com'],
        // 已知播放器域名；实际判定不再依赖此列表（见 isPlayerFrame），仅作参考
        PLAYER_HOSTS: ['plala.py1080p.com', 'py1080p.com'],
        STORAGE_KEY: 'CZzyv_Watch_History_v1',
        RESUME_STORAGE_KEY: 'CZzyv_Watch_History_Resume_Target_v1',
        MAX_HISTORY: 200,
        PLAY_PAGE_REG: /\/v_play\/[^/]+\.html/i,
        SAVE_INTERVAL: 10000,
        RECORD_INTERVAL: 10000,
        IFRAME_PROGRESS_MESSAGE: 'CZ_HISTORY_IFRAME_PROGRESS',
        IFRAME_RESUME_MESSAGE: 'CZ_HISTORY_IFRAME_RESUME',
        IFRAME_RESUME_ACK_MESSAGE: 'CZ_HISTORY_IFRAME_RESUME_ACK',
        RESUME_TOLERANCE: 3,
        RESUME_PROTECT_MS: 15000,
        RESUME_DISPATCH_INTERVAL: 800,
        RESUME_DISPATCH_MAX_COUNT: 15,
        RESUME_EXPIRE_MS: 10 * 60 * 1000,
        IFRAME_REPORT_INTERVAL: 10000,
        MIN_VALID_PROGRESS_SECONDS: 3,
        PREVENT_ZERO_PROGRESS_OVERWRITE: true,
        SKIP_ZERO_PROGRESS_RECORD: true,
        LATEST_EPISODE_CHECK_ON_INIT: true,
        LATEST_EPISODE_FETCH_TIMEOUT: 12000,
        LATEST_EPISODE_REQUEST_DELAY: 500
    };

    let lastSaveAt = 0;
    let latestIframeProgress = null;
    let pendingResumeTarget = null;
    let pendingResumeStartAt = 0;
    let pendingResumeDone = false;
    let resumeDispatchTimer = null;
    let resumeDispatchCount = 0;

    // 正在fetch封面图的historyKey集合，防止重复请求
    const posterFetchingSet = new Set();

    function hostMatches(hostList) {
        const host = location.hostname;
        return hostList.some(item => host === item || host.endsWith('.' + item));
    }
    function isMainSiteHost() { return hostMatches(CONFIG.SITE_HOSTS); }
    function isPlayerHost() { return hostMatches(CONFIG.PLAYER_HOSTS); }
    function isInIframe() { return window.self !== window.top; }
    function isPlayPage() { return CONFIG.PLAY_PAGE_REG.test(location.pathname); }
    function isMovieDetailPage() { return /\/movie\/\d+\.html/i.test(location.pathname); }

    // ★ 关键修复：播放器 iframe 的域名会被站点随时更换（如从 plala.py1080p.com 换成
    // 159.75.162.215:3001）。不再用域名白名单判定，凡是"在 iframe 内 且 不是主站"
    // 一律按播放器帧处理，避免对方换域名后脚本整体失效。
    function isPlayerFrame() { return isInIframe() && !isMainSiteHost(); }

    // === 日志 ===
    const LOG_TAG = isPlayerFrame() ? '[观影历史/IFRAME]' : '[观影历史/TOP]';
    // warn 始终输出，用于排查错误；log 仅在调试模式下输出
    function log(...args) { if (DEBUG) console.log(LOG_TAG, ...args); }
    function warn(...args) { console.warn(LOG_TAG, ...args); }

    // 节流日志：同一 key 在 intervalMs 内只输出一次，减少刷屏
    const _throttleMap = {};
    function throttledLog(key, intervalMs, ...args) {
        if (!DEBUG) return;
        const now = Date.now();
        const last = _throttleMap[key] || 0;
        if (now - last >= intervalMs) { _throttleMap[key] = now; log(...args); }
    }

    // 脚本加载确认（始终输出，仅一行）
    console.log(`[观影历史] v1.2.0 已注入 ${isPlayerFrame() ? '播放器帧' : '主站'} | ${location.hostname}`);

    function normalizeUrl(url) {
        try { const u = new URL(url, location.href); u.hash = ''; return u.href; }
        catch (e) { return String(url || '').split('#')[0]; }
    }

    function parseTimeToSeconds(text) {
        if (!text) return 0;
        const arr = String(text).trim().split(':').map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n));
        if (arr.length === 2) return arr[0] * 60 + arr[1];
        if (arr.length === 3) return arr[0] * 3600 + arr[1] * 60 + arr[2];
        return 0;
    }

    function formatSeconds(seconds) {
        seconds = Math.floor(Number(seconds) || 0);
        const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function parseProgressText(text) {
        if (!text) return null;
        const match = String(text).replace(/\s+/g, ' ').trim().match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*\/\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
        if (!match) return null;
        return { currentTime: parseTimeToSeconds(match[1]), duration: parseTimeToSeconds(match[2]), progressText: `${match[1]} / ${match[2]}` };
    }

    function escapeHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function querySelectorAllDeep(selector, root = document) {
        const result = [];
        try { result.push(...root.querySelectorAll(selector)); } catch (e) {}
        let all = [];
        try { all = Array.from(root.querySelectorAll('*')); } catch (e) {}
        for (const el of all) { if (el.shadowRoot) result.push(...querySelectorAllDeep(selector, el.shadowRoot)); }
        return result;
    }

    function getProgressFromVideo() {
        const videos = querySelectorAllDeep('video', document);
        const video = videos && videos.length ? videos[0] : null;
        if (!video) return { currentTime: 0, duration: 0, progressText: '' };
        const ct = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const dur = Number.isFinite(video.duration) ? video.duration : 0;
        if (!ct && !dur) return { currentTime: 0, duration: 0, progressText: '' };
        return { currentTime: ct, duration: dur, progressText: dur ? `${formatSeconds(ct)} / ${formatSeconds(dur)}` : formatSeconds(ct) };
    }

    function getProgressFromCurrentDocument() {
        const selectors = [
            '.art-control.art-control-time[data-index="30"]',
            '.art-control.art-control-time',
            '.art-controls-left .art-control-time',
            '.art-control-time',
            '[class*="art-control-time"]'
        ];
        for (const selector of selectors) {
            const nodes = querySelectorAllDeep(selector, document);
            for (const node of nodes) {
                const result = parseProgressText(node.textContent || node.innerText || node.getAttribute('aria-label') || '');
                if (result && result.progressText) return result;
            }
        }
        const leftControls = querySelectorAllDeep('.art-controls-left', document);
        for (const node of leftControls) {
            const result = parseProgressText(node.textContent || node.innerText || '');
            if (result && result.progressText) return result;
        }
        return getProgressFromVideo();
    }

    // === iframe 播放器通信 ===
    let iframeActiveSeekTimer = null, iframeActiveSeekTarget = 0, iframeSeekAttemptCount = 0;
    let iframeLastResumeKey = '', iframeResumeFinished = false;

    function sendIframeResumeAck(seconds) {
        log('回执跳转完成 ACK', { 目标秒: seconds });
        try { window.top.postMessage({ type: CONFIG.IFRAME_RESUME_ACK_MESSAGE, currentTime: seconds, href: location.href, time: Date.now() }, '*'); } catch (e) { warn('ACK 发送失败', e); }
    }

    function reportIframeProgressNow() {
        const progress = getProgressFromCurrentDocument();
        if (!progress || !progress.progressText) { log('立即上报：未取到进度，跳过'); return; }
        log('立即上报进度', progress.progressText, progress);
        try { window.top.postMessage({ type: CONFIG.IFRAME_PROGRESS_MESSAGE, progress, href: location.href, time: Date.now() }, '*'); } catch (e) { warn('进度上报失败', e); }
    }

    function startIframeSeek(seconds, autoPlay = true) {
        seconds = Number(seconds) || 0;
        log('收到跳转请求', { 目标秒: seconds, 自动播放: autoPlay });
        if (seconds <= 0) return;
        const resumeKey = `${Math.floor(seconds)}`;
        if (iframeResumeFinished && iframeLastResumeKey === resumeKey) { log('该目标已跳转完成，忽略重复请求'); return; }
        iframeLastResumeKey = resumeKey; iframeResumeFinished = false;
        iframeActiveSeekTarget = seconds; iframeSeekAttemptCount = 0;
        if (iframeActiveSeekTimer) { clearInterval(iframeActiveSeekTimer); iframeActiveSeekTimer = null; }
        function doSeek() {
            iframeSeekAttemptCount++;
            const videos = querySelectorAllDeep('video', document);
            if (!videos.length) {
                if (iframeSeekAttemptCount % 10 === 0) log('跳转等待中：页面尚无 video 元素', { 第几次: iframeSeekAttemptCount });
                if (iframeSeekAttemptCount >= 60) { warn('跳转放弃：60 次仍未找到 video'); clearInterval(iframeActiveSeekTimer); iframeActiveSeekTimer = null; }
                return;
            }
            let finished = false;
            for (const video of videos) {
                try {
                    let target = iframeActiveSeekTarget;
                    const duration = Number.isFinite(video.duration) ? video.duration : 0;
                    if (duration > 0 && target >= duration - 2) target = Math.max(0, duration - 5);
                    const before = Number(video.currentTime) || 0;
                    if (before < target - CONFIG.RESUME_TOLERANCE) {
                        video.currentTime = target;
                        throttledLog('seekExec', 5000, '执行 seek', { 从: before.toFixed(1), 到: target.toFixed(1), 总时长: duration.toFixed(1) });
                    } else finished = true;
                    if (autoPlay) { const p = video.play && video.play(); if (p && typeof p.catch === 'function') p.catch(err => log('自动播放被浏览器拦截（正常，需手动点播放）', err && err.name)); }
                    if ((Number(video.currentTime) || 0) >= target - CONFIG.RESUME_TOLERANCE) finished = true;
                } catch (e) { warn('seek 异常', e); }
            }
            reportIframeProgressNow();
            if (finished || iframeSeekAttemptCount >= 60) {
                log(finished ? '跳转成功' : '跳转超时结束', { 目标秒: iframeActiveSeekTarget, 尝试次数: iframeSeekAttemptCount });
                iframeResumeFinished = true;
                if (iframeActiveSeekTimer) { clearInterval(iframeActiveSeekTimer); iframeActiveSeekTimer = null; }
                sendIframeResumeAck(iframeActiveSeekTarget);
            }
        }
        doSeek();
        iframeActiveSeekTimer = setInterval(doSeek, 500);
        setTimeout(doSeek, 300); setTimeout(doSeek, 1000); setTimeout(doSeek, 2000);
    }

    function startIframeProgressReporter() {
        log('播放器帧上报器已启动');
        let lastText = '';
        function reportProgress(reason) {
            const progress = getProgressFromCurrentDocument();
            if (!progress || !progress.progressText) return;
            if (progress.progressText === lastText) return;
            lastText = progress.progressText;
            throttledLog('reportProgress', 30000, '上报进度', progress.progressText, '来源:', reason || 'poll');
            try { window.top.postMessage({ type: CONFIG.IFRAME_PROGRESS_MESSAGE, progress, href: location.href, time: Date.now() }, '*'); } catch (e) { warn('进度上报失败', e); }
        }
        window.addEventListener('message', function (event) {
            const data = event.data;
            if (!data || data.type !== CONFIG.IFRAME_RESUME_MESSAGE) return;
            const seconds = Number(data.currentTime) || 0;
            log('收到顶层消息 RESUME', { 秒: seconds, 来源: event.origin });
            if (seconds > 0) startIframeSeek(seconds, data.autoPlay !== false);
        });
        setInterval(() => reportProgress('poll'), CONFIG.IFRAME_REPORT_INTERVAL);
        const observer = new MutationObserver(() => reportProgress('dom'));
        if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        // ★ 新增：直接挂 video 事件，比只靠轮询/DOM 变化更可靠
        let lastEventReport = 0;
        document.addEventListener('timeupdate', e => {
            if (!e.target || e.target.tagName !== 'VIDEO') return;
            const now = Date.now();
            if (now - lastEventReport < 5000) return;
            lastEventReport = now;
            reportProgress('timeupdate');
        }, true);
        ['pause', 'seeked', 'ended'].forEach(evt => {
            document.addEventListener(evt, e => {
                if (e.target && e.target.tagName === 'VIDEO') reportProgress(evt);
            }, true);
        });

        document.addEventListener('loadedmetadata', e => {
            if (e.target && e.target.tagName === 'VIDEO') {
                log('video loadedmetadata', { 时长: e.target.duration });
                if (iframeActiveSeekTarget > 0 && !iframeResumeFinished) startIframeSeek(iframeActiveSeekTarget, true);
            }
        }, true);
        document.addEventListener('canplay', e => {
            if (e.target && e.target.tagName === 'VIDEO' && iframeActiveSeekTarget > 0 && !iframeResumeFinished) startIframeSeek(iframeActiveSeekTarget, true);
        }, true);
        setTimeout(() => reportProgress('init-0.5s'), 500);
        setTimeout(() => reportProgress('init-1.5s'), 1500);
        setTimeout(() => reportProgress('init-3s'), 3000);
        setTimeout(() => {
            const n = querySelectorAllDeep('video', document).length;
            log('3 秒自检：找到 video 元素数量 =', n, n ? '' : '（若为 0，说明播放器结构变化或未加载完）');
        }, 3000);
    }

    if (isPlayerFrame()) { startIframeProgressReporter(); return; }
    if (!isMainSiteHost()) { log('非主站且非播放器帧，脚本退出'); return; }

    // === 历史存取 ===
    function getHistory() {
        try {
            const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? dedupeHistoryBySeries(list) : [];
        } catch (e) { return []; }
    }
    function saveHistory(list) {
        try { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(list.slice(0, CONFIG.MAX_HISTORY))); } catch (e) {}
    }

    function saveResumeTarget(item) {
        if (!item || !item.url) return;
        const ct = Number(item.currentTime) || 0;
        if (ct <= 0) return;
        try {
            localStorage.setItem(CONFIG.RESUME_STORAGE_KEY, JSON.stringify({
                url: item.url, currentTime: ct, duration: Number(item.duration) || 0,
                title: item.title || '', time: Date.now()
            }));
        } catch (e) {}
    }

    function loadResumeTarget() {
        try {
            const raw = localStorage.getItem(CONFIG.RESUME_STORAGE_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!data || !data.url || !(Number(data.currentTime) > 0)) return null;
            if (Date.now() - (Number(data.time) || 0) > CONFIG.RESUME_EXPIRE_MS) { clearResumeTarget(); return null; }
            if (normalizeUrl(data.url) !== normalizeUrl(location.href)) return null;
            return { url: data.url, currentTime: Number(data.currentTime) || 0, duration: Number(data.duration) || 0, title: data.title || '', time: Number(data.time) || Date.now() };
        } catch (e) { return null; }
    }

    function clearResumeTarget() { try { localStorage.removeItem(CONFIG.RESUME_STORAGE_KEY); } catch (e) {} }

    function stopResumeDispatcher() {
        pendingResumeDone = true; clearResumeTarget();
        if (resumeDispatchTimer) { clearInterval(resumeDispatchTimer); resumeDispatchTimer = null; }
    }

    function sendResumeMessageToIframes() {
        if (!pendingResumeTarget || pendingResumeDone) return;
        const ct = Number(pendingResumeTarget.currentTime) || 0;
        if (ct <= 0) return;
        const iframes = document.querySelectorAll('iframe');
        if (!iframes.length) { throttledLog('noIframe', 5000, '派发跳转：页面暂无 iframe（等待播放器加载）'); return; }
        for (const iframe of iframes) {
            try {
                iframe.contentWindow.postMessage({
                    type: CONFIG.IFRAME_RESUME_MESSAGE, currentTime: ct,
                    duration: Number(pendingResumeTarget.duration) || 0,
                    url: pendingResumeTarget.url, autoPlay: true, time: Date.now()
                }, '*');
            } catch (e) { warn('向 iframe 派发跳转失败', e); }
        }
    }

    // ★ 诊断用：打印页面上所有 iframe 的真实地址。
    // 站点更换播放器域名时，这里能第一时间看出来（对照 @match 是否覆盖）。
    function logIframeInfo() {
        const iframes = Array.from(document.querySelectorAll('iframe'));
        if (!iframes.length) { log('页面无 iframe'); return; }
        const info = iframes.map((f, i) => {
            const src = f.getAttribute('src') || f.src || '(无 src)';
            let host = '';
            try { host = new URL(src, location.href).hostname; } catch (e) {}
            const covered = CONFIG.PLAYER_HOSTS.some(h => host === h || host.endsWith('.' + h));
            return { i, host: host || '?', covered };
        });
        log('页面 iframe:', info);
        const uncovered = info.filter(x => x.host !== '?' && !x.covered);
        if (uncovered.length) {
            warn('⚠ 以下 iframe 域名不在已知列表，若功能失效请反馈补 @match：',
                 uncovered.map(x => x.host).join(', '));
        }
    }

    function startResumeDispatcher() {
        if (!isPlayPage()) return;
        const target = loadResumeTarget();
        if (!target || !(target.currentTime > 0)) {
            log('无待跳转目标（正常打开播放页，或目标已过期/地址不匹配）');
            return;
        }
        log('★ 检测到待跳转目标', { 标题: target.title, 秒: target.currentTime, 显示: formatSeconds(target.currentTime) });
        pendingResumeTarget = target; pendingResumeStartAt = Date.now();
        pendingResumeDone = false; resumeDispatchCount = 0;
        function dispatch() {
            if (!pendingResumeTarget || pendingResumeDone) { stopResumeDispatcher(); return; }
            resumeDispatchCount++; sendResumeMessageToIframes();
            if (resumeDispatchCount >= CONFIG.RESUME_DISPATCH_MAX_COUNT) {
                warn(`已派发跳转 ${resumeDispatchCount} 次仍无 ACK 回执，放弃。`,
                     '通常说明播放器 iframe 内脚本未注入 —— 请查看上方 iframe src 日志，确认域名是否在 @match 覆盖范围内。');
                stopResumeDispatcher();
            }
        }
        dispatch();
        if (resumeDispatchTimer) clearInterval(resumeDispatchTimer);
        resumeDispatchTimer = setInterval(dispatch, CONFIG.RESUME_DISPATCH_INTERVAL);
        setTimeout(dispatch, 300); setTimeout(dispatch, 1000); setTimeout(dispatch, 2000);
    }

    function bindIframeProgressMessage() {
        window.addEventListener('message', function (event) {
            const data = event.data;
            if (!data) return;
            if (data.type === CONFIG.IFRAME_RESUME_ACK_MESSAGE) {
                log('✔ 收到 iframe 跳转完成 ACK', { 秒: data.currentTime });
                stopResumeDispatcher(); return;
            }
            if (data.type !== CONFIG.IFRAME_PROGRESS_MESSAGE || !data.progress || !data.progress.progressText) return;
            latestIframeProgress = {
                currentTime: data.progress.currentTime || 0, duration: data.progress.duration || 0,
                progressText: data.progress.progressText, time: Date.now(), iframeHref: data.href || ''
            };
            throttledLog('recvProgress', 30000, '✔ 收到 iframe 进度', data.progress.progressText);
            if (pendingResumeTarget && !pendingResumeDone && latestIframeProgress.currentTime >= pendingResumeTarget.currentTime - CONFIG.RESUME_TOLERANCE) {
                log('进度已达到跳转目标，停止派发');
                stopResumeDispatcher();
            }
            recordCurrentPlayPage(false);
        });
    }

    function getProgress() {
        const p = getProgressFromCurrentDocument();
        if (p && p.progressText) return p;
        if (latestIframeProgress && latestIframeProgress.progressText) return latestIframeProgress;
        return getProgressFromVideo();
    }

    function getMovieTitle() {
        const ptitLink = document.querySelector('.mi_cont .paycon h3.ptit a, h3.ptit a');
        if (ptitLink && ptitLink.textContent.trim()) return ptitLink.textContent.trim();
        return document.title
            .replace(/第\s*\d+\s*集/g, '').replace(/在线观看.*$/g, '')
            .replace(/免费播放.*$/g, '').replace(/在线播放.*$/g, '')
            .replace(/[-_].*$/g, '').replace(/\s+/g, ' ').trim() || location.href;
    }

    function getEpisodeText() {
        const ptitEpisode = document.querySelector('.mi_cont .paycon h3.ptit span, h3.ptit span');
        if (ptitEpisode && ptitEpisode.textContent.trim()) return ptitEpisode.textContent.trim();
        const currentEpisode = document.querySelector('.juji_list .pbplay');
        if (currentEpisode && currentEpisode.textContent.trim()) return `第${currentEpisode.textContent.trim()}集`;
        return '';
    }

    let latestEpisodeRefreshing = false;
    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    function chineseNumberToInt(text) {
        text = String(text || '').trim();
        if (!text) return 0;
        if (/^\d+$/.test(text)) return parseInt(text, 10) || 0;
        const map = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
        const unitMap = { '十': 10, '百': 100, '千': 1000, '万': 10000 };
        let total = 0, section = 0, number = 0;
        for (const ch of text) {
            if (Object.prototype.hasOwnProperty.call(map, ch)) number = map[ch];
            else if (Object.prototype.hasOwnProperty.call(unitMap, ch)) {
                const unit = unitMap[ch];
                if (unit === 10000) { section = (section + number) * unit; total += section; section = 0; }
                else section += (number || 1) * unit;
                number = 0;
            }
        }
        return total + section + number;
    }

    function extractEpisodeNumber(text) {
        text = String(text || '').replace(/\s+/g, '').trim();
        if (!text) return 0;
        let match = text.match(/(?:第|EP|E)?(\d{1,4})(?:集|话|期|$)/i);
        if (match) return parseInt(match[1], 10) || 0;
        match = text.match(/(?:第)?([一二两三四五六七八九十百千万〇零]{1,10})(?:集|话|期)/);
        if (match) return chineseNumberToInt(match[1]);
        if (/^\d{1,4}$/.test(text)) return parseInt(text, 10) || 0;
        return 0;
    }

    function getEpisodeDetectRoot(doc = document) {
        if (!doc) return null;
        try {
            if (doc === document && doc.body) {
                const cloned = doc.body.cloneNode(true);
                cloned.querySelectorAll([
                    '#czzyv-history-btn', '#czzyv-history-panel', '#czzyv-history-list',
                    '.czzyv-history-item', '.czzyv-history-latest', '.czzyv-history-title',
                    '.czzyv-history-progress-text', '.czzyv-history-op'
                ].join(',')).forEach(el => { try { el.remove(); } catch (e) {} });
                return cloned;
            }
        } catch (e) {}
        return doc;
    }

    function detectLatestEpisodeFromDocument(doc = document) {
        if (!doc) return null;
        const root = getEpisodeDetectRoot(doc);
        if (!root) return null;
        let maxEpisode = 0;
        try {
            const bodyText = root.textContent || '';
            const updateMatch = bodyText.match(/更新至\s*([0-9一二两三四五六七八九十百千万〇零]+)\s*(集|话|期)/);
            if (updateMatch) { const num = chineseNumberToInt(updateMatch[1]); if (num > maxEpisode) maxEpisode = num; }
        } catch (e) {}
        const selectors = [
            '.juji_list a', '.juji_list li', '.juji_list span',
            '.paly_list_btn a', '.playlist a', '.play-list a',
            '.episode-list a', '.anthology-list a', 'a[href*="/v_play/"]'
        ];
        for (const selector of selectors) {
            let nodes = [];
            try { nodes = Array.from(root.querySelectorAll(selector)); } catch (e) {}
            for (const node of nodes) {
                try { if (node.closest && node.closest('#czzyv-history-panel, #czzyv-history-btn')) continue; } catch (e) {}
                const num = extractEpisodeNumber((node.textContent || node.innerText || node.getAttribute('title') || '').trim());
                if (num > maxEpisode) maxEpisode = num;
            }
        }
        if (maxEpisode > 0) return { number: maxEpisode, text: `更新至${maxEpisode}集` };
        return null;
    }

    async function fetchTextWithTimeout(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, CONFIG.LATEST_EPISODE_FETCH_TIMEOUT);
        try {
            const res = await fetch(url, { credentials: 'include', signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } finally { clearTimeout(timer); }
    }

    // === 封面图相关 ===
    function extractMovieIdFromPlayUrl(url) {
        try {
            const u = new URL(url, location.href);
            const match = u.pathname.match(/\/v_play\/([^/]+)\.html/i);
            if (!match) return '';
            const decoded = atob(match[1]);
            const idMatch = decoded.match(/mv_(\d+)/);
            return idMatch ? idMatch[1] : '';
        } catch (e) { return ''; }
    }

    function buildDetailUrl(playUrl) {
        try {
            const movieId = extractMovieIdFromPlayUrl(playUrl);
            if (!movieId) return '';
            const u = new URL(playUrl);
            return `${u.origin}/movie/${movieId}.html`;
        } catch (e) { return ''; }
    }

    function extractPosterFromDocument(doc) {
        if (!doc) return '';
        const selectors = ['.mi_ne_kd.dypre .dyimg.fl img', '.mi_ne_kd .dyimg img', '.dyimg img'];
        for (const sel of selectors) {
            const img = doc.querySelector(sel);
            if (img) {
                const src = img.getAttribute('src') || img.src || '';
                if (src && src !== 'about:blank' && !src.startsWith('data:')) return src;
            }
        }
        const ogImage = doc.querySelector('meta[property="og:image"]');
        if (ogImage && ogImage.getAttribute('content')) return ogImage.getAttribute('content');
        return '';
    }

    async function fetchAndUpdatePoster(historyKey, detailUrl) {
        if (!historyKey || !detailUrl) return;
        if (posterFetchingSet.has(historyKey)) return;
        posterFetchingSet.add(historyKey);
        try {
            const html = await fetchTextWithTimeout(detailUrl);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const poster = extractPosterFromDocument(doc);
            if (!poster) return;
            const list = getHistory();
            const index = list.findIndex(item => getHistorySeriesKey(item) === historyKey);
            if (index >= 0 && !list[index].poster) {
                list[index].poster = poster;
                saveHistory(list);
                renderHistoryList();
            }
        } catch (e) {
            console.warn('[观影历史] 封面图fetch失败', e);
        } finally {
            posterFetchingSet.delete(historyKey);
        }
    }

    function updatePosterFromDetailPage() {
        if (!isMovieDetailPage()) return;
        const poster = extractPosterFromDocument(document);
        if (!poster) return;
        const h1 = document.querySelector('.moviedteail_tt h1');
        const movieTitle = h1 ? h1.textContent.trim() : '';
        if (!movieTitle) return;
        const key = normalizeSeriesKey(movieTitle);
        if (!key) return;
        const list = getHistory();
        let changed = false;
        for (let i = 0; i < list.length; i++) {
            if (getHistorySeriesKey(list[i]) === key) {
                list[i].poster = poster;
                list[i].detailUrl = location.href;
                changed = true;
            }
        }
        if (changed) { saveHistory(list); renderHistoryList(); }
    }

    // === 后台刷新：集数 + 封面图 ===
    // ★ 修复：集数从播放页检测，封面图从详情页获取，两者并行请求
    async function refreshLatestEpisodesForHistory(force = false) {
        if (latestEpisodeRefreshing) return;
        latestEpisodeRefreshing = true;
        try {
            const snapshot = getHistory();
            for (const oldItem of snapshot) {
                if (!oldItem || !oldItem.url) continue;
                const key = getHistorySeriesKey(oldItem) || normalizeUrl(oldItem.url);
                const isSeries = isSeriesLikeHistoryItem(oldItem);
                const needEpisodeCheck = isSeries && (force || !oldItem.latestEpisodeText || !Number(oldItem.latestEpisodeNumber));
                const needPoster = !oldItem.poster;
                if (!needEpisodeCheck && !needPoster) continue;

                const detailUrl = oldItem.detailUrl || buildDetailUrl(oldItem.url);
                let latest = null;
                let poster = '';

                // 集数从播放页检测，封面图从详情页获取，并行请求
                const promises = [];

                if (needEpisodeCheck && oldItem.url) {
                    promises.push((async () => {
                        try {
                            const playHtml = await fetchTextWithTimeout(oldItem.url);
                            const playDoc = new DOMParser().parseFromString(playHtml, 'text/html');
                            latest = detectLatestEpisodeFromDocument(playDoc);
                        } catch (e) { /* 静默失败 */ }
                    })());
                }

                if (needPoster && detailUrl) {
                    promises.push((async () => {
                        try {
                            const detailHtml = await fetchTextWithTimeout(detailUrl);
                            const detailDoc = new DOMParser().parseFromString(detailHtml, 'text/html');
                            poster = extractPosterFromDocument(detailDoc);
                        } catch (e) { /* 静默失败 */ }
                    })());
                }

                await Promise.all(promises);
                await sleep(CONFIG.LATEST_EPISODE_REQUEST_DELAY);

                const currentList = getHistory();
                const index = currentList.findIndex(item => (getHistorySeriesKey(item) || normalizeUrl(item.url)) === key);
                if (index >= 0) {
                    const now = Date.now();
                    const cur = currentList[index];

                    if (needEpisodeCheck && latest) {
                        currentList[index].latestEpisodeNumber = latest.number || Number(cur.latestEpisodeNumber) || 0;
                        currentList[index].latestEpisodeText = latest.text || cur.latestEpisodeText || '';
                        currentList[index].latestEpisodeCheckedAt = now;
                    }
                    if (needPoster && poster) {
                        currentList[index].poster = poster;
                    }
                    if (detailUrl && !currentList[index].detailUrl) {
                        currentList[index].detailUrl = detailUrl;
                    }
                    saveHistory(currentList);
                    renderHistoryList();
                }
            }
        } finally { latestEpisodeRefreshing = false; }
    }

    function normalizeSeriesKey(text) {
        return String(text || '').replace(/\s+/g, '').replace(/[：:]/g, '').trim().toLowerCase();
    }

    function getHistorySeriesKey(item) {
        if (!item) return '';
        if (item.historyKey) return item.historyKey;
        if (item.movieTitle) return normalizeSeriesKey(item.movieTitle);
        const title = String(item.title || '')
            .replace(/第\s*\d+\s*集/g, '').replace(/第\s*[一二三四五六七八九十百千万]+\s*集/g, '')
            .replace(/\s+/g, ' ').trim();
        return normalizeSeriesKey(title);
    }

    function isSeriesLikeHistoryItem(item) {
        if (!item) return false;
        const ep = String(item.episodeText || '');
        const title = String(item.title || '');
        if (ep && extractEpisodeNumber(ep) > 0) return true;
        if (/第\s*\d{1,4}\s*(集|话|期)/.test(title)) return true;
        if (/第\s*[一二两三四五六七八九十百千万〇零]{1,10}\s*(集|话|期)/.test(title)) return true;
        return false;
    }

    function dedupeHistoryBySeries(list) {
        const seen = new Set(), result = [];
        for (const item of list || []) {
            const key = getHistorySeriesKey(item) || normalizeUrl(item.url || '');
            if (!key || seen.has(key)) continue;
            seen.add(key); result.push(item);
        }
        return result;
    }

    function recordCurrentPlayPage(force = false) {
        if (!isPlayPage()) return;
        const now = Date.now();
        if (!force && now - lastSaveAt < CONFIG.SAVE_INTERVAL) return;

        const progress = getProgress();
        const currentTime = Number(progress.currentTime) || 0;
        const duration = Number(progress.duration) || 0;
        const movieTitle = getMovieTitle();
        const episodeText = getEpisodeText();
        const displayTitle = episodeText ? `${movieTitle} ${episodeText}` : movieTitle;
        const historyKey = normalizeSeriesKey(movieTitle);

        let list = getHistory();
        const oldItem = list.find(item => { const k = getHistorySeriesKey(item); return k && k === historyKey; });
        const oldCurrentTime = oldItem ? Number(oldItem.currentTime) || 0 : 0;
        const minValid = Number(CONFIG.MIN_VALID_PROGRESS_SECONDS) || 3;
        const isZero = currentTime < minValid;

        if (isZero) {
            if (CONFIG.PREVENT_ZERO_PROGRESS_OVERWRITE && oldItem && oldCurrentTime >= minValid) {
                log('跳过记录：本次进度为 0，保护已有记录不被覆盖', { 已有: formatSeconds(oldCurrentTime), 标题: displayTitle });
                return;
            }
            if (CONFIG.SKIP_ZERO_PROGRESS_RECORD && !oldItem) {
                warn('跳过记录：未取到播放进度（', displayTitle, '），可能播放器尚未加载');
                if (!latestIframeProgress) {
                    warn('  原因：从未收到 iframe 进度上报，请确认播放器域名在 @match 范围内。')
                }
                log('跳过记录详情', {
                    标题: displayTitle,
                    取到的进度: progress.progressText || '(空)',
                    iframe上报进度: latestIframeProgress ? latestIframeProgress.progressText : '(从未收到)',
                    顶层文档进度: getProgressFromCurrentDocument().progressText || '(空)'
                });
                return;
            }
        }
        if (pendingResumeTarget && !pendingResumeDone &&
            now - pendingResumeStartAt < CONFIG.RESUME_PROTECT_MS &&
            pendingResumeTarget.currentTime > 5 &&
            currentTime < pendingResumeTarget.currentTime - CONFIG.RESUME_TOLERANCE) return;

        lastSaveAt = now;

        const isSeriesLike = isSeriesLikeHistoryItem({ title: displayTitle, episodeText });
        const latestInfo = isSeriesLike ? detectLatestEpisodeFromDocument(document) : null;
        const latestNum = (latestInfo && latestInfo.number) ? latestInfo.number : (oldItem ? Number(oldItem.latestEpisodeNumber) || 0 : 0);

        const newWatchedEp = extractEpisodeNumber(episodeText) || 0;

        let watchedEpisodeNumber;
        if (oldItem) {
            watchedEpisodeNumber = Math.max(Number(oldItem.watchedEpisodeNumber) || 0, newWatchedEp);
        } else {
            watchedEpisodeNumber = Math.max(newWatchedEp, latestNum);
        }

        const detailUrl = (oldItem && oldItem.detailUrl) ? oldItem.detailUrl : buildDetailUrl(location.href);
        const isFirstRecord = !oldItem;

        const item = {
            url: location.href,
            title: displayTitle,
            movieTitle,
            episodeText,
            historyKey,
            watchedEpisodeNumber,
            latestEpisodeNumber: isSeriesLike ? latestNum : 0,
            latestEpisodeText: isSeriesLike ? ((latestInfo && latestInfo.text) ? latestInfo.text : (oldItem ? oldItem.latestEpisodeText || '' : '')) : '',
            latestEpisodeCheckedAt: isSeriesLike ? (latestInfo ? now : (oldItem ? oldItem.latestEpisodeCheckedAt || 0 : 0)) : 0,
            currentTime,
            duration,
            progressText: progress.progressText || '',
            time: now,
            host: location.hostname,
            pathname: location.pathname,
            detailUrl,
            poster: (oldItem && oldItem.poster) ? oldItem.poster : ''
        };

        list = list.filter(x => getHistorySeriesKey(x) !== historyKey);
        list.unshift(item);
        saveHistory(list);
        renderHistoryList();

        if (isFirstRecord && !item.poster && detailUrl) {
            fetchAndUpdatePoster(historyKey, detailUrl);
        }
    }

    function deleteHistory(url) {
        const list = getHistory().filter(item => item.url !== url);
        saveHistory(list); renderHistoryList();
    }

    function clearHistory() {
        if (!confirm('确定要清空全部观影历史吗？')) return;
        saveHistory([]); renderHistoryList();
    }

    // === UI ===
    function addStyle() {
        const style = document.createElement('style');
        style.textContent = `
            #czzyv-history-btn {
                position: fixed; right: 24px; top: 10px; z-index: 999999;
                width: 38px; height: 38px; border-radius: 50%;
                background: #202124; color: #fff; cursor: pointer;
                box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
                user-select: none;
                display: flex; align-items: center; justify-content: center;
                transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
            }
            #czzyv-history-btn:hover {
                background: #2b2c30;
                transform: translateY(-1px);
                box-shadow: 0 10px 26px rgba(0, 0, 0, 0.36);
            }
            #czzyv-history-btn:active {
                transform: translateY(0) scale(0.98);
            }
            #czzyv-history-panel {
                position: fixed; right: 18px; top: 28px; width: 330px;
                max-width: calc(100vw - 36px); height: 500px;
                max-height: calc(100vh - 36px); background: #202020; color: #e7e9ee;
                z-index: 999999; border-radius: 16px;
                box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42), inset 0 0 0 1px rgba(255, 255, 255, 0.06);
                display: none; overflow: hidden; font-size: 14px;
                animation: slideIn 0.18s ease;
                border: 1px solid rgba(255, 255, 255, 0.08);
            }
            #czzyv-history-panel::before {
                content: ''; position: absolute; top: -10px; left: 49%;
                width: 20px; height: 20px; background: #202020;
                border-left: 1px solid rgba(255, 255, 255, 0.08);
                border-top: 1px solid rgba(255, 255, 255, 0.08);
                transform: rotate(45deg); border-radius: 3px 0 0 0;
            }
            @keyframes slideIn {
                from { opacity: 0; transform: translateY(-6px); }
                to { opacity: 1; transform: translateY(0); }
            }
            #czzyv-history-panel.czzyv-show { display: block; }
            #czzyv-history-list {
                height: 100%; overflow-y: auto; padding: 12px 0 12px;
                box-sizing: border-box; background: #202020; position: relative;
            }
            #czzyv-history-list::-webkit-scrollbar { width: 6px; }
            #czzyv-history-list::-webkit-scrollbar-track {
                background: transparent;
            }
            #czzyv-history-list::-webkit-scrollbar-thumb {
                background: #d8dde3; border-radius: 6px;
                transition: background 0.2s;
            }
            #czzyv-history-list::-webkit-scrollbar-thumb:hover {
                background: #c2c8cf;
            }
            .czzyv-history-empty {
                color: #8d8f95; text-align: center; padding: 128px 20px;
                font-size: 14px; line-height: 1.7;
            }
            .czzyv-history-item {
                background: transparent; border-radius: 0; margin: 0;
                padding: 9px 12px 9px 14px; box-sizing: border-box;
                cursor: pointer;
                transition: background 0.16s ease;
                display: grid; grid-template-columns: 126px minmax(0, 1fr); align-items: start; gap: 10px;
                border: 0;
                position: relative;
                overflow: hidden;
            }
            .czzyv-history-item::before {
                content: ''; display: none;
            }
            .czzyv-history-item:hover {
                background: #3b3b3d;
            }
            .czzyv-history-item:active {
                background: #454548;
            }
            .czzyv-history-poster {
                flex-shrink: 0; width: 126px; height: 78px;
                border-radius: 5px; overflow: hidden;
                background: #2b2c30;
                box-shadow: none;
                position: relative;
            }
            .czzyv-history-poster img {
                width: 100%; height: 100%; object-fit: cover; display: block;
                transition: transform 0.18s ease;
            }
            .czzyv-history-item:hover .czzyv-history-poster img {
                transform: scale(1.03);
            }
            .czzyv-history-poster-badge {
                position: absolute; left: 0; right: 0; bottom: 0;
                min-height: 24px; padding: 8px 8px 5px; box-sizing: border-box;
                background: linear-gradient(to top, rgba(0, 0, 0, 0.68), rgba(0, 0, 0, 0));
                color: #fff; font-size: 12px; line-height: 1;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .czzyv-history-poster-placeholder {
                width: 100%; height: 100%;
                display: flex; align-items: center; justify-content: center;
                flex-direction: column; gap: 4px;
                color: #8d8f95; font-size: 12px; font-weight: 400;
            }
            .czzyv-history-poster-placeholder::before {
                content: ''; display: none;
            }
            .czzyv-history-info {
                flex: 1; min-width: 0; min-height: 78px; position: relative;
                display: flex; flex-direction: column; padding-top: 2px;
            }
            .czzyv-history-head {
                display: flex; justify-content: space-between; align-items: flex-start;
                margin-bottom: 0; gap: 10px;
            }
            .czzyv-history-title {
                font-size: 15px; font-weight: 400; color: #e7e9ee;
                line-height: 1.32; flex: 1;
                transition: color 0.16s ease;
                display: -webkit-box; -webkit-line-clamp: 2;
                -webkit-box-orient: vertical; overflow: hidden;
                word-break: break-word;
            }
            .czzyv-history-item:hover .czzyv-history-title { color: #ff5c38; }
            .czzyv-history-episode {
                display: inline-block; margin-left: 6px; padding: 0 6px;
                font-size: 11px; line-height: 18px; font-weight: 400;
                color: #b8bbc2; background: rgba(255, 255, 255, 0.10);
                border-radius: 4px; white-space: nowrap;
                vertical-align: 1px;
            }
            .czzyv-history-item:hover .czzyv-history-episode { color: #c9ccd3; }
            .czzyv-history-tags {
                display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
                margin: 2px 0 0 0; min-height: 0;
            }
            .czzyv-history-latest {
                color: #9b9da3; font-weight: 400; font-size: 12px;
                background: transparent;
                padding: 0; border-radius: 0;
                white-space: nowrap;
                display: inline-block;
            }
            .czzyv-history-newbadge {
                background: #ff5c38;
                color: #fff; font-size: 10px; font-weight: 500;
                padding: 1px 4px; border-radius: 3px;
                line-height: 1.6; display: inline-block;
                box-shadow: none;
            }
            .czzyv-history-delete {
                background: transparent; border: none; cursor: pointer;
                padding: 4px; color: #686b73; flex-shrink: 0; line-height: 0;
                transition: color 0.16s ease, background 0.16s ease; border-radius: 4px;
                position: relative; z-index: 10;
            }
            .czzyv-history-delete svg { width: 14px; height: 14px; }
            .czzyv-history-delete:hover {
                background: rgba(255, 255, 255, 0.08);
                color: #c2c5cc;
            }
            .czzyv-progress-text {
                margin-top: 4px;
                font-size: 13px; color: #8d8f95;
                transition: color 0.16s ease;
                line-height: 1.5; display: flex; align-items: center; gap: 6px;
            }
            .czzyv-history-item:hover .czzyv-progress-text { color: #b8bbc2; }
            .czzyv-progress-text::before {
                content: ''; display: none;
            }
            .czzyv-progress-bar {
                display: none;
            }
            .czzyv-progress-fill {
                height: 100%; background: #00cc4c; border-radius: 999px;
                transition: width 0.18s ease;
            }
        `;
        document.head.appendChild(style);
    }

    function createUI() {
        if (document.querySelector('#czzyv-history-btn')) return;
        const btn = document.createElement('div');
        btn.id = 'czzyv-history-btn';
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
        btn.title = '观影历史';

        const panel = document.createElement('div');
        panel.id = 'czzyv-history-panel';
        panel.innerHTML = `
            <div id="czzyv-history-list"></div>
        `;
        document.body.appendChild(btn);
        document.body.appendChild(panel);

        btn.addEventListener('mouseenter', () => { panel.classList.add('czzyv-show'); renderHistoryList(); });
        btn.addEventListener('mouseleave', () => {
            setTimeout(() => { if (!panel.matches(':hover') && !btn.matches(':hover')) panel.classList.remove('czzyv-show'); }, 200);
        });
        panel.addEventListener('mouseleave', () => {
            setTimeout(() => { if (!panel.matches(':hover') && !btn.matches(':hover')) panel.classList.remove('czzyv-show'); }, 200);
        });
        panel.addEventListener('click', e => e.stopPropagation());
        document.addEventListener('click', () => panel.classList.remove('czzyv-show'));
        renderHistoryList();
    }

    function renderHistoryList() {
        const box = document.querySelector('#czzyv-history-list');
        if (!box) return;
        const list = getHistory();
        if (!list.length) { box.innerHTML = `<div class="czzyv-history-empty">暂无观影历史<br>开始观看后会自动记录</div>`; return; }

        const historyHtml = list.map((item, index) => {
            const currentTime = Number(item.currentTime) || 0;
            const duration = Number(item.duration) || 0;
            const progressPercent = duration > 0 ? Math.max(0, Math.min(100, Math.round(currentTime / duration * 100))) : 0;
            const displayProgressText = duration > 0 && currentTime > 0
                ? (progressPercent > 0 ? `观看至${progressPercent}%` : '观看不足1%')
                : (item.progressText ? `观看至${item.progressText}` : '未记录进度');

            const shouldShowLatest = isSeriesLikeHistoryItem(item);
            const latestText = shouldShowLatest && item.latestEpisodeText ? item.latestEpisodeText : '';
            const latestBadgeHtml = latestText
                ? `<div class="czzyv-history-poster-badge">${escapeHtml(latestText)}</div>`
                : '';

            let newBadgeHtml = '';
            if (shouldShowLatest &&
                Number(item.latestEpisodeNumber) > 0 &&
                Number(item.watchedEpisodeNumber) > 0 &&
                item.latestEpisodeNumber > item.watchedEpisodeNumber) {
                newBadgeHtml = `<span class="czzyv-history-newbadge">有更新</span>`;
            }

            const posterUrl = item.poster || '';
            const posterHtml = posterUrl
                ? `<div class="czzyv-history-poster"><img src="${escapeHtml(posterUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='<div class=czzyv-history-poster-placeholder>无图</div>'">${latestBadgeHtml}</div>`
                : `<div class="czzyv-history-poster"><div class="czzyv-history-poster-placeholder">海报</div>${latestBadgeHtml}</div>`;
            const tagsHtml = newBadgeHtml
                ? `<div class="czzyv-history-tags">${newBadgeHtml}</div>`
                : '';

            let episodeText = String(item.episodeText || '').trim();
            let mainTitle = String(item.movieTitle || '').trim();
            if (!mainTitle) {
                mainTitle = String(item.title || '').trim();
                if (episodeText && mainTitle.endsWith(episodeText)) {
                    mainTitle = mainTitle.slice(0, -episodeText.length).trim();
                } else if (!episodeText) {
                    const epMatch = mainTitle.match(/(第\s*(?:\d{1,4}|[一二两三四五六七八九十百千万〇零]{1,10})\s*(?:集|话|期))\s*$/);
                    if (epMatch) {
                        episodeText = epMatch[1].replace(/\s+/g, '');
                        mainTitle = mainTitle.slice(0, epMatch.index).trim();
                    }
                }
            }
            const titleHtml = mainTitle && episodeText
                ? `${escapeHtml(mainTitle)}<span class="czzyv-history-episode">${escapeHtml(episodeText)}</span>`
                : escapeHtml(item.title || mainTitle);

            return `
                <div class="czzyv-history-item" data-url="${escapeHtml(item.url)}" data-index="${index}">
                    ${posterHtml}
                    <div class="czzyv-history-info">
                        <div class="czzyv-history-head">
                            <div class="czzyv-history-title">
                                ${titleHtml}
                            </div>
                            <button class="czzyv-history-delete" data-url="${escapeHtml(item.url)}" title="删除">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                            </button>
                        </div>
                        ${tagsHtml}
                        <div class="czzyv-progress-text">${escapeHtml(displayProgressText)}</div>
                        <div class="czzyv-progress-bar"><div class="czzyv-progress-fill" style="width: ${progressPercent}%;"></div></div>
                    </div>
                </div>
            `;
        }).join('');

        box.innerHTML = historyHtml;

        box.querySelectorAll('.czzyv-history-item').forEach(card => {
            card.addEventListener('click', function (e) {
                if (e.target.closest('.czzyv-history-delete')) return;
                const index = parseInt(this.getAttribute('data-index'), 10);
                const list = getHistory();
                const item = list[index];
                if (!item) return;

                if (Number(item.latestEpisodeNumber) > Number(item.watchedEpisodeNumber)) {
                    item.watchedEpisodeNumber = item.latestEpisodeNumber;
                    list[index] = item;
                    saveHistory(list);
                    renderHistoryList();
                }

                saveResumeTarget(item);
                const a = document.createElement('a');
                a.href = item.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.style.display = 'none';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
            });
        });

        box.querySelectorAll('.czzyv-history-delete').forEach(btn => {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                deleteHistory(this.getAttribute('data-url'));
            });
        });
    }

    function bindVideoEvents() {
        const video = document.querySelector('video');
        if (!video || video.__czzyvHistoryBound) return;
        video.__czzyvHistoryBound = true;
        video.addEventListener('play', () => setTimeout(() => recordCurrentPlayPage(true), 1000));
        video.addEventListener('pause', () => recordCurrentPlayPage(true));
        video.addEventListener('ended', () => recordCurrentPlayPage(true));
        let lastUpdate = 0;
        video.addEventListener('timeupdate', () => {
            const now = Date.now();
            if (now - lastUpdate >= 10000) { lastUpdate = now; recordCurrentPlayPage(false); }
        });
        video.addEventListener('loadedmetadata', () => setTimeout(() => recordCurrentPlayPage(true), 1000));
        video.addEventListener('seeked', () => recordCurrentPlayPage(true));
    }

    function observePageChange() {
        const observer = new MutationObserver(() => { bindVideoEvents(); if (isPlayPage()) recordCurrentPlayPage(false); });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    function startIntervalRecord() {
        setInterval(() => { if (isPlayPage()) recordCurrentPlayPage(true); }, CONFIG.RECORD_INTERVAL);
    }

    function bindBeforeUnload() {
        window.addEventListener('beforeunload', () => recordCurrentPlayPage(true));
        window.addEventListener('pagehide', () => recordCurrentPlayPage(true));
    }

    function init() {
        bindIframeProgressMessage();
        addStyle();
        createUI();

        if (isMovieDetailPage()) {
            setTimeout(() => updatePosterFromDetailPage(), 500);
        }

        if (CONFIG.LATEST_EPISODE_CHECK_ON_INIT) {
            setTimeout(() => refreshLatestEpisodesForHistory(true), 1000);
        }

        if (isPlayPage()) {
            // ★ 诊断：打印页面所有 iframe 真实地址。站点换播放器域名时，
            // 一眼就能看出新域名是否在 @match 覆盖范围内。iframe 可能晚于脚本加载，故多次打印。
            setTimeout(logIframeInfo, 500);
            setTimeout(logIframeInfo, 2500);
            startResumeDispatcher();
            setTimeout(() => recordCurrentPlayPage(true), 1000);
            setTimeout(() => recordCurrentPlayPage(true), 3000);
            setTimeout(() => recordCurrentPlayPage(true), 6000);
        }
        bindVideoEvents();
        observePageChange();
        startIntervalRecord();
        bindBeforeUnload();
    }

    init();
})();
