# Chat CLS/LCP Regression

This runner measures the deployed chat with Chromium's standard hard-navigation
LCP and the Chrome soft-navigation LCP used when a cached conversation is
restored. It also records CLS entries, their affected nodes, timeline scroll
snapshots and the existing pagination/windowing contracts.

Local authentication, discovered message IDs and generated reports are ignored
by Git. Do not put credentials in this repository.

```bash
# Opens a browser for normal login, including captcha or 2FA.
npm run perf:chat:auth

# Select one conversation with at least 100 messages and historical text,
# single-image and multi-image rows.
CHAT_PERF_CONVERSATION_ROUTE=/chats/@me/<public-id> npm run perf:chat:discover

# Five repetitions on desktop and mobile by default.
npm run perf:chat
```

Useful local overrides:

```bash
CHAT_PERF_RUNS=3 CHAT_PERF_VIEWPORTS=desktop npm run perf:chat
CHAT_PERF_DISABLE_CACHE=0 npm run perf:chat
CHAT_PERF_SKIP_CONTRACTS=1 npm run perf:chat
CHAT_PERF_RUNS=1 CHAT_PERF_RESTORE_TRACE=1 npm run perf:chat
CHAT_PERF_RUNS=1 CHAT_PERF_GEOMETRY_TRACE=1 npm run perf:chat
```

`CHAT_PERF_RESTORE_TRACE=1` adds detailed saved-window, scroll-write,
ResizeObserver and visual-viewport events to each historical scenario result.
`CHAT_PERF_GEOMETRY_TRACE=1` includes the app's opt-in row, spacer, history and
layout-shift correlation stream in the generated report.

Historical scroll state belongs to the live conversation runtime and is not
persisted across F5. Therefore the historical scenarios use a genuine
user-initiated SPA route-away and route-back restore. The latest-page scenario
also records a separate hard reload for standard page-load LCP.

## Media Rendering Checks

Run from `VOID0000-www`. The media tests need Chromium from Playwright and
`ffmpeg` on PATH to generate small, real JPEG/MP4 fixtures.

```bash
# Local rendering: reserved geometry, loading priority, fallback, spoilers,
# mixed attachments, and poster-to-native-video playback.
node --test --test-concurrency=1 scripts/tests/attachments/mediaPerformance.test.mjs scripts/tests/attachments/video.test.mjs

# Public deployed JS/CSS with intercepted API, WebSocket, and media fixtures.
# No login or production data writes; this is a functional deployment smoke.
MEDIA_TEST_DEPLOYED_URL=https://void0000.online node --test scripts/tests/attachments/mediaTimeline.test.mjs

# Real authenticated production requests, three reloads per viewport by default.
# First log in with perf:chat:auth and select an accessible conversation.
CHAT_PERF_CONVERSATION_ROUTE=/chats/@me/<public-id> CHAT_PERF_RUNS=3 CHAT_PERF_PLAY=1 node scripts/performance/media-startup.mjs
```

The production measurement disables the browser HTTP cache and records CLS,
LCP candidates, resource eligibility, JavaScript errors, and playback attempts
at 1280x900 and 390x844. It focuses the composer and scrolls without sending
messages; `CHAT_PERF_PLAY=1` additionally clicks a video poster if one exists.
It preserves rotated login cookies in the ignored authentication file.
Do not run competing processes against that same authentication file.

JSON reports are written to ignored `performance-results/media-*.json` files.
`interactionMaxMs` is the maximum observed Event Timing duration for the small
scripted interaction sample, not a field INP measurement. A missing video is
reported as `playback.attempted=false`, not a successful playback check.

The deployed fixture deliberately delays media; its LCP values are not real
network performance measurements. Compare production runs only with matching
conversation content, viewport, cache policy, and similar system/network load.
In particular, a text LCP candidate does not reproduce a reported video LCP.

### First-Pass Findings

The original renderer eagerly loaded eligible images and mounted native video
elements immediately. Those behaviors are replaced with per-frame viewport
priority and poster-first playback. Existing deterministic frame dimensions,
display variants, retry handling, and the timeline architecture are retained.

The representative mixed-media tests measured zero media-load CLS both before
and after the change. The available authenticated DM had a text LCP candidate
and no videos in its latest window. Consequently, neither that DM nor the
fixture reproduces the reported 0.60 CLS incident. These checks establish
geometry stability in the covered scenarios, not resolution of that incident.

## Trim Geometry Regression

```bash
# Real DOM, both densities and viewport widths, 220 mixed-height messages.
node --test scripts/tests/messages/trimGeometry.test.mjs

# Reproduce the measurement race using the two old owners from 273c88f.
# A test-only Vite loader reads Git; it does not alter the working tree.
TRIM_BASELINE=1 node --test scripts/tests/messages/trimGeometry.test.mjs

# Same routed regression using the actual deployed JS/CSS, with fixture data.
TRIM_DEPLOYED_URL=https://void0000.online node --test scripts/tests/messages/trimGeometry.test.mjs

# Existing authenticated conversation, actual production history responses.
# Requires enough messages to cross the >80 trigger; does not create messages.
CHAT_PERF_CONVERSATION_ROUTE=/chats/@me/<public-id> node scripts/performance/trim-scroll.mjs
```

Reports in ignored `performance-results/trim-*.json` include removed DOM heights,
cached/runtime/estimated heights where available, spacer totals, boundary row
traits, visible anchor offsets, and opt-in geometry/CLS events around each commit.
The production smoke keeps rotated authentication state in the ignored login
file. Do not run two processes with the same authentication file concurrently.

The measurement handoff case applies two real window commits before the next
animation frame. Previously, cleanup cancelled the pending height publication:
the view cache changed but runtime measurements stayed stale. A 0.625px change
across 20 measured rows produced a 12.5px trim-accounting deficit. Measurements
are now published in their layout/ResizeObserver batch, retain fractional
precision, and estimates no longer populate the authoritative measured cache.

Ordinary mixed-history runs already had <=0.5px anchor displacement and no trim
CLS before this correction. Do not describe the accounting regression as a
measured 12.5px production viewport jump. The existing anchor restoration can
hide a spacer error. No pagination, grouping, physical spacer limits, or scroll
compensation mechanisms were changed by this correction.
