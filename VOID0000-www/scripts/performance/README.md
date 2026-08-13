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
```

Historical scroll state belongs to the live conversation runtime and is not
persisted across F5. Therefore the historical scenarios use a genuine
user-initiated SPA route-away and route-back restore. The latest-page scenario
also records a separate hard reload for standard page-load LCP.
