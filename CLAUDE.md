# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Tampermonkey userscript that adds watch history tracking, playback progress, auto-resume, and episode update detection to the 厂长资源 (CZ) video streaming site.

**Core functionality:**
- Tracks viewing history with auto-fetched poster images
- Records precise playback progress across pages and windows
- Auto-resumes from last position when reopening from history
- Detects new episodes for series and displays update badges
- Cross-domain iframe communication between main site and player domains

## Architecture

### Multi-domain operation

The script runs in two distinct execution contexts:

1. **Main site** (`czzyv.com`, `4kcz.com`) — manages UI, history storage, and orchestrates resume
2. **Player iframe** (various domains including `plala.py1080p.com`, `py1080p.com`, `159.75.162.215`) — reports progress and handles seeking

**Critical implementation detail:** Player iframe detection uses `isPlayerFrame() = isInIframe() && !isMainSiteHost()` rather than a domain whitelist, because the site frequently changes player domains without notice. This means any iframe that isn't the main site is treated as a potential player.

### Communication protocol

- `IFRAME_PROGRESS_MESSAGE` — player → main site: current playback position
- `IFRAME_RESUME_MESSAGE` — main site → player: target seek position
- `IFRAME_RESUME_ACK_MESSAGE` — player → main site: seek completed

All use `postMessage` with origin `*` due to dynamic player domains.

### Data storage

- `CZzyv_Watch_History_v1` — localStorage array of history items, deduplicated by series
- `CZzyv_Watch_History_Resume_Target_v1` — pending resume target (expires after 10 minutes)

History items store `historyKey` (normalized series identifier), `watchedEpisodeNumber`, `latestEpisodeNumber`, `poster`, `detailUrl`, and progress.

### Key flows

**Recording progress:**
1. Player iframe polls `<video>` element and ArtPlayer time display
2. Reports via `postMessage` to main site every 10s or on video events
3. Main site merges iframe progress with local progress and saves to history
4. Zero-progress records are skipped to avoid overwriting valid history

**Auto-resume:**
1. User clicks history item → `saveResumeTarget()` stores target in localStorage
2. New window opens play page → `loadResumeTarget()` checks for pending target
3. `startResumeDispatcher()` sends `IFRAME_RESUME_MESSAGE` every 800ms up to 15 times
4. Player iframe receives message → `startIframeSeek()` sets `video.currentTime` via 500ms interval
5. Player sends ACK when seek completes → main site stops dispatching

**Episode detection:**
1. Parses episode numbers from text (supports Chinese numerals: 一二三 etc.)
2. Scans DOM for "更新至X集" text and episode list links
3. Background refresh fetches play page HTML to detect latest episode
4. Compares `latestEpisodeNumber` vs `watchedEpisodeNumber` to show "有更新" badge

**Poster fetching:**
1. Extracts movie ID from base64-encoded play URL (`/v_play/` → `/movie/`)
2. Fetches detail page HTML in background
3. Parses `.mi_ne_kd .dyimg img` or `og:image` meta tag
4. Updates history item and re-renders UI

### UI structure

- Floating ⏰ button (fixed top-right) shows on hover
- Dark panel with vertical history list
- Each item: poster thumbnail (126×78px) + title + episode badge + progress + "有更新" badge
- Click item → saves resume target and opens in new window
- Delete button per item

## Code Conventions

- Pure vanilla JavaScript, zero dependencies
- `@grant none` — no Tampermonkey API usage
- Console logging controlled by `localStorage.CZ_HISTORY_DEBUG='1'`
- `warn()` always outputs (errors/diagnostics), `log()` only in debug mode
- Throttled logging via `throttledLog(key, intervalMs)` to reduce spam
- All time values in seconds (convert to formatted strings for display)

## Debugging

Enable detailed logging:
```js
localStorage.setItem('CZ_HISTORY_DEBUG', '1')
// refresh page
```

**Common issues:**

- **Progress not recording** — Check `logIframeInfo()` output at 0.5s and 2.5s after page load. If iframe domain isn't in `@match` list, script won't inject into player.
- **Resume not working** — Look for "已派发跳转 X 次仍无 ACK 回执" warning. Usually means player iframe script not injected.
- **Zero progress saved** — `SKIP_ZERO_PROGRESS_RECORD` prevents recording when no progress detected. Check if iframe reported progress via "✔ 收到 iframe 进度" throttled log.

## Development Notes

- When site changes player domains, update `@match` patterns in userscript header
- `isPlayerFrame()` diagnostic logs show all iframe src URLs to catch domain changes early
- History deduplication uses `normalizeSeriesKey()` (removes spaces, colons, lowercases)
- Series detection looks for "第X集" pattern in title or episode text
- Poster fetch uses `Set` to prevent duplicate concurrent requests per `historyKey`
- Resume dispatcher runs max 15 times then gives up to avoid infinite loops
- Video seek protection: won't overwrite progress during first 15s after resume starts

## Versioning

- **一次会话只升级一次 `@version`，除非用户特别要求。** 同一轮对话里做的所有改动（无论几个功能/修复）只 bump 一个小版本号一次；不要每改一处就升一版（例如一次会话内从 1.2.1 升到 1.2.2 即可，不要升到 1.2.3）。
- 用户明确说"升版本"或"更新版本号"时才可多次升级。
