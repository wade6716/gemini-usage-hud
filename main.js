// ==UserScript==
// @name         Gemini Usage HUD
// @namespace    https://github.com/your-username/gemini-usage-hud
// @version      1.0.0
// @description  在 Gemini 对话页面优雅展示 5 小时与每周剩余额度、精确点数及重置倒计时（支持双引擎降级、深浅色自适应、拖拽记忆位置）
// @author       YourName
// @match        https://gemini.google.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const APP_ID = 'gemini-usage-hud';
    const RPC_ID = 'jSf9Qc';
    const STORAGE_POS = `${APP_ID}:pos`;

    const REFRESH_INTERVAL_MS = 2 * 60 * 1000; // 2 分钟低频轮询，避免风控
    const STALE_THRESHOLD_MS = 60 * 1000;      // 切回标签页超过 1 分钟自动刷新
    const REQUEST_TIMEOUT_MS = 12000;

    const state = {
        short: null,
        weekly: null,
        loading: false,
        error: '',
        lastUpdatedAt: 0,
        drag: { active: false, moved: false, startX: 0, startY: 0, left: 0, top: 0 }
    };

    const refs = {};

    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

    // ================= 1. 数据获取（RPC 优先 + HTML 降级） =================

    async function fetchViaRPC() {
        const data = window.WIZ_global_data || {};
        if (!data.cfb2h || !data.FdrFJe || !data.SNlM0e) {
            throw new Error('WIZ_global_data 未就绪');
        }

        const query = new URLSearchParams({
            rpcids: RPC_ID,
            'source-path': '/usage',
            bl: data.cfb2h,
            'f.sid': data.FdrFJe,
            hl: data.GGcqce || document.documentElement.lang || 'zh-CN',
            _reqid: String(Math.floor(100000 + Math.random() * 9000000)),
            rt: 'c'
        });

        const body = new URLSearchParams({
            'f.req': JSON.stringify([[[RPC_ID, '[]', null, 'generic']]]),
            at: data.SNlM0e
        });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const res = await fetch(`/_/BardChatUi/data/batchexecute?${query}`, {
                method: 'POST',
                credentials: 'include',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'X-Same-Domain': '1'
                },
                body: body.toString()
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return parseRPCResponse(await res.text());
        } finally {
            clearTimeout(timer);
        }
    }

    function parseRPCResponse(text) {
        let rpcPayload = null;
        for (const rawLine of text.split('\n')) {
            const line = rawLine.trim();
            if (!line.startsWith('[')) continue;
            try {
                const frame = JSON.parse(line);
                if (!Array.isArray(frame)) continue;
                for (const entry of frame) {
                    if (Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === RPC_ID) {
                        rpcPayload = JSON.parse(entry[2]);
                        break;
                    }
                }
                if (rpcPayload) break;
            } catch { /* 忽略非 JSON 长度行 */ }
        }

        const rows = Array.isArray(rpcPayload?.[1]) ? rpcPayload[1] : [];
        const result = { short: null, weekly: null };

        for (const row of rows) {
            if (!Array.isArray(row)) continue;
            const remaining = Number(row[0]);
            const usedRatio = Number(row[1]);
            const type = Number(row[2]);
            const resetSec = Number(row[3]?.[0]?.[0]);
            const resetMicros = Number(row[3]?.[0]?.[1] || 0);

            if (!Number.isFinite(type)) continue;
            const item = {
                remaining: Number.isFinite(remaining) ? remaining : null,
                remainingRatio: Number.isFinite(usedRatio) ? clamp(1 - usedRatio, 0, 1) : null,
                resetAt: Number.isFinite(resetSec) ? resetSec * 1000 + Math.floor(resetMicros / 1000) : 0
            };
            if (type === 1) result.short = item;
            if (type === 2) result.weekly = item;
        }

        if (!result.short && !result.weekly) throw new Error('RPC 未返回用量数据');
        return result;
    }

    async function fetchViaHTMLFallback() {
        const res = await fetch('https://gemini.google.com/usage', { credentials: 'include' });
        if (!res.ok) throw new Error(`HTML HTTP ${res.status}`);
        const html = await res.text();

        const parsePool = (poolType) => {
            const regex = new RegExp(
                poolType + '\\\\*"[\\s\\S]{0,120}?percentageUsed\\\\*":\\s*([\\d.]+)[\\s\\S]{0,120}?windowRefreshesAt\\\\*":\\\\*"([^"\\\\]+)'
            );
            const m = html.match(regex);
            if (!m) return null;
            const usedRatio = parseFloat(m[1]);
            return {
                remaining: null,
                remainingRatio: clamp(1 - usedRatio, 0, 1),
                resetAt: new Date(m[2]).getTime() || 0
            };
        };

        const result = {
            short: parsePool('GXU_FIVE_HOURLY'),
            weekly: parsePool('GXU_WEEKLY')
        };
        if (!result.short && !result.weekly) throw new Error('HTML 未解析到用量');
        return result;
    }

    async function refreshUsage() {
        if (state.loading) return;
        state.loading = true;
        state.error = '';
        render();

        try {
            let usage;
            try {
                usage = await fetchViaRPC();
            } catch {
                usage = await fetchViaHTMLFallback();
            }
            state.short = usage.short || state.short;
            state.weekly = usage.weekly || state.weekly;
            state.lastUpdatedAt = Date.now();
        } catch (err) {
            state.error = err?.name === 'AbortError' ? '请求超时' : '获取失败';
        } finally {
            state.loading = false;
            render();
        }
    }

    // ================= 2. 格式化工具 =================

    function formatNum(n) {
        return Number.isFinite(n) ? new Intl.NumberFormat('zh-CN').format(n) : '';
    }

    function formatPct(ratio) {
        return Number.isFinite(ratio) ? `${Math.round(clamp(ratio, 0, 1) * 100)}%` : '--';
    }

    function formatCountdown(ts) {
        if (!ts) return '--';
        const diff = ts - Date.now();
        if (diff <= 0) return '即将重置';
        const mins = Math.ceil(diff / 60000);
        const d = Math.floor(mins / 1440);
        const h = Math.floor((mins % 1440) / 60);
        const m = mins % 60;
        if (d > 0) return `${d}天${h}时`;
        if (h > 0) return `${h}时${m}分`;
        return `${m}分`;
    }

    function formatExactTime(ts) {
        if (!ts) return '未知';
        return new Intl.DateTimeFormat('zh-CN', {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
        }).format(new Date(ts));
    }

    function getStatusColor(ratio) {
        if (!Number.isFinite(ratio)) return '#9aa0a6';
        if (ratio >= 0.5) return '#34a853';  // 绿：充裕
        if (ratio >= 0.2) return '#fbbc04';  // 黄：注意
        return '#ea4335';                    // 红：紧张
    }

    // ================= 3. Shadow DOM UI 构建 =================

    function createItem(labelText) {
        const wrap = document.createElement('div');
        wrap.className = 'hud-item';

        const dot = document.createElement('span');
        dot.className = 'hud-dot';

        const label = document.createElement('span');
        label.className = 'hud-label';
        label.textContent = labelText;

        const pct = document.createElement('span');
        pct.className = 'hud-pct';
        pct.textContent = '--';

        const pts = document.createElement('span');
        pts.className = 'hud-pts';

        const reset = document.createElement('span');
        reset.className = 'hud-reset';

        wrap.append(dot, label, pct, pts, reset);
        return { wrap, dot, pct, pts, reset };
    }

    function createWidget() {
        if (document.getElementById(APP_ID)) return;

        const host = document.createElement('div');
        host.id = APP_ID;
        document.documentElement.appendChild(host);

        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
            :host {
                all: initial;
                color-scheme: light dark;
                font-family: "Google Sans", system-ui, -apple-system, sans-serif;
            }
            .hud {
                --bg: color-mix(in srgb, Canvas 84%, transparent);
                --border: color-mix(in srgb, CanvasText 14%, transparent);
                --text: color-mix(in srgb, CanvasText 92%, transparent);
                --muted: color-mix(in srgb, CanvasText 56%, transparent);
                position: fixed;
                right: 20px;
                bottom: 16px;
                z-index: 2147483647;
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 6px 12px;
                border-radius: 999px;
                background: var(--bg);
                border: 1px solid var(--border);
                box-shadow: 0 4px 16px color-mix(in srgb, CanvasText 12%, transparent);
                backdrop-filter: blur(14px);
                color: var(--text);
                font-size: 12px;
                line-height: 1;
                cursor: grab;
                user-select: none;
                touch-action: none;
                transition: opacity 0.2s ease;
            }
            .hud[data-dragging="1"] { cursor: grabbing; opacity: 0.85; }
            .hud[data-loading="1"] { opacity: 0.7; }
            .hud-item { display: flex; align-items: center; gap: 5px; }
            .hud-dot { width: 7px; height: 7px; border-radius: 50%; background: #9aa0a6; flex-shrink: 0; }
            .hud-label { color: var(--muted); font-weight: 500; }
            .hud-pct { font-weight: 700; }
            .hud-pts { color: var(--muted); font-size: 11px; }
            .hud-reset { color: var(--muted); font-size: 11px; }
            .hud-sep { width: 1px; height: 12px; background: var(--border); }
            .hud-err { color: #ea4335; font-weight: 600; }
        `;

        const panel = document.createElement('div');
        panel.className = 'hud';
        panel.title = '左键点击立即刷新，按住可拖拽位置';

        const shortItem = createItem('5h余');
        const sep = document.createElement('div');
        sep.className = 'hud-sep';
        const weeklyItem = createItem('周余');

        const errSpan = document.createElement('span');
        errSpan.className = 'hud-err';
        errSpan.style.display = 'none';

        panel.append(shortItem.wrap, sep, weeklyItem.wrap, errSpan);
        shadow.append(style, panel);

        Object.assign(refs, { panel, short: shortItem, weekly: weeklyItem, sep, errSpan });

        restorePosition();
        bindEvents();
    }

    function updateItemUI(itemRefs, data, titlePrefix) {
        if (!data) {
            itemRefs.pct.textContent = '--';
            itemRefs.pts.textContent = '';
            itemRefs.reset.textContent = '';
            return;
        }
        const color = getStatusColor(data.remainingRatio);
        itemRefs.dot.style.background = color;
        itemRefs.pct.style.color = color;
        itemRefs.pct.textContent = formatPct(data.remainingRatio);
        itemRefs.pts.textContent = data.remaining !== null ? `(${formatNum(data.remaining)})` : '';
        itemRefs.reset.textContent = data.resetAt ? `· ${formatCountdown(data.resetAt)}` : '';
        itemRefs.wrap.title = `${titlePrefix}剩余 ${formatPct(data.remainingRatio)}` +
            (data.remaining !== null ? ` (${formatNum(data.remaining)})` : '') +
            `\n重置时间：${formatExactTime(data.resetAt)}`;
    }

    function render() {
        if (!refs.panel) return;
        refs.panel.dataset.loading = state.loading ? '1' : '0';

        if (state.error && !state.short && !state.weekly) {
            refs.short.wrap.style.display = 'none';
            refs.sep.style.display = 'none';
            refs.weekly.wrap.style.display = 'none';
            refs.errSpan.style.display = 'inline';
            refs.errSpan.textContent = `${state.error} (点击重试)`;
            return;
        }

        refs.short.wrap.style.display = 'flex';
        refs.sep.style.display = 'block';
        refs.weekly.wrap.style.display = 'flex';
        refs.errSpan.style.display = 'none';

        updateItemUI(refs.short, state.short, '5小时');
        updateItemUI(refs.weekly, state.weekly, '每周');
    }

    // ================= 4. 拖拽与交互事件 =================

    function restorePosition() {
        try {
            const pos = JSON.parse(localStorage.getItem(STORAGE_POS) || 'null');
            if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
                refs.panel.style.left = `${clamp(pos.left, 8, window.innerWidth - 120)}px`;
                refs.panel.style.top = `${clamp(pos.top, 8, window.innerHeight - 40)}px`;
                refs.panel.style.right = 'auto';
                refs.panel.style.bottom = 'auto';
            }
        } catch { /* ignore */ }
    }

    function savePosition() {
        const r = refs.panel.getBoundingClientRect();
        localStorage.setItem(STORAGE_POS, JSON.stringify({ left: r.left, top: r.top }));
    }

    function bindEvents() {
        const el = refs.panel;

        el.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const r = el.getBoundingClientRect();
            state.drag = { active: true, moved: false, startX: e.clientX, startY: e.clientY, left: r.left, top: r.top };
            el.setPointerCapture(e.pointerId);
        });

        el.addEventListener('pointermove', (e) => {
            if (!state.drag.active) return;
            const dx = e.clientX - state.drag.startX;
            const dy = e.clientY - state.drag.startY;
            if (!state.drag.moved && Math.hypot(dx, dy) > 4) {
                state.drag.moved = true;
                el.dataset.dragging = '1';
            }
            if (!state.drag.moved) return;

            el.style.left = `${clamp(state.drag.left + dx, 8, window.innerWidth - el.offsetWidth - 8)}px`;
            el.style.top = `${clamp(state.drag.top + dy, 8, window.innerHeight - el.offsetHeight - 8)}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        });

        el.addEventListener('pointerup', (e) => {
            if (!state.drag.active) return;
            const wasMoved = state.drag.moved;
            state.drag.active = false;
            el.dataset.dragging = '0';
            el.releasePointerCapture(e.pointerId);

            if (wasMoved) {
                savePosition();
            } else {
                refreshUsage(); // 未拖动则视为点击刷新
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && Date.now() - state.lastUpdatedAt > STALE_THRESHOLD_MS) {
                refreshUsage();
            }
        });

        window.addEventListener('resize', () => {
            if (el.style.left) {
                const r = el.getBoundingClientRect();
                el.style.left = `${clamp(r.left, 8, window.innerWidth - el.offsetWidth - 8)}px`;
                el.style.top = `${clamp(r.top, 8, window.innerHeight - el.offsetHeight - 8)}px`;
                savePosition();
            }
        });
    }

    // ================= 5. 启动 =================

    createWidget();
    refreshUsage();

    setInterval(() => {
        if (document.visibilityState === 'visible') refreshUsage();
    }, REFRESH_INTERVAL_MS);

    setInterval(() => {
        if (document.visibilityState === 'visible' && (state.short || state.weekly)) render();
    }, 30 * 1000); // 每 30 秒更新一次倒计时显示
})();
