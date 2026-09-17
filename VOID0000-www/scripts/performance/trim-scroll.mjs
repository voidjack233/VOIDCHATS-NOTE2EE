// Read-only deployed timeline smoke. Login using perf:chat:auth first.
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { normalizeConversationRoute } from './chat-cls-lcp-core.mjs';

const config = JSON.parse(await fs.readFile('.playwright/chat-cls-lcp.local.json', 'utf8'));
const base = process.env.CHAT_PERF_BASE_URL || config.baseUrl;
const route = normalizeConversationRoute(process.env.CHAT_PERF_CONVERSATION_ROUTE || config.conversationRoute, base);
const auth = '.playwright/chat-perf-auth.json';
const browser = await chromium.launch();
const records = [];
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ storageState: auth, viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem('void:message-geometry-debug', '1'));
    const snapshot = () => page.locator('[data-message-timeline]').evaluate(s => {
      const bounds = s.getBoundingClientRect();
      const rows = [...s.querySelectorAll('[data-message-id]')].map(r => {
        const box = r.getBoundingClientRect();
        return { id: r.dataset.messageId, top: box.top, height: box.height, visible: box.bottom > bounds.top && box.top < bounds.bottom };
      });
      return { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, rows,
        top: s.querySelector('[data-message-older-range]')?.getBoundingClientRect().height || 0,
        bottom: s.querySelector('[data-message-newer-range]')?.getBoundingClientRect().height || 0 };
    });
    let inFlight = null;
    await page.route('**/messages?**', async request => {
      const url = new URL(request.request().url());
      if (!url.searchParams.has('before') && !url.searchParams.has('after')) return request.continue();
      let finish; inFlight = new Promise(resolve => { finish = resolve; });
      try {
        const response = await request.fetch();
        const before = await snapshot();
        await page.evaluate(() => window.clearMessageGeometryDebugReport?.());
        await request.fulfill({ response });
        await page.waitForTimeout(600);
        const after = await snapshot();
        const removed = before.rows.filter(r => !after.rows.some(a => a.id === r.id));
        const anchors = before.rows.filter(r => r.visible).map(r => ({ id: r.id, before: r.top, after: after.rows.find(a => a.id === r.id)?.top }));
        const events = await page.evaluate(() => window.__VOID_MESSAGE_GEOMETRY_DEBUG__ || []);
        const record = { width, direction: url.searchParams.has('before') ? 'older' : 'newer', status: response.status(),
          before, after, removed, anchors, events,
          displacement: Math.max(0, ...anchors.filter(a => a.after !== undefined).map(a => Math.abs(a.after - a.before))) };
        records.push(record);
        console.log(JSON.stringify({ width, direction: record.direction, status: record.status, count: after.rows.length,
          removed: removed.length, displacement: record.displacement,
          shifts: events.filter(e => e.event === 'layout_shift').map(e => e.payload.value) }));
      } finally { finish(); }
    });
    try {
      await page.goto(`${base}${route}`);
      await page.locator('[data-message-id]').first().waitFor({ timeout: 45000 });
      await page.waitForTimeout(1500);
      for (const direction of [...Array(10).fill('older'), ...Array(10).fill('newer')]) {
        // Do not count our next scroll as displacement during an outstanding
        // startup reconciliation or pagination response measurement.
        await inFlight;
        const previous = inFlight;
        const hasRange = await page.locator('[data-message-timeline]').evaluate((s, direction) => {
          const range = s.querySelector(direction === 'older' ? '[data-message-older-range]' : '[data-message-newer-range]');
          if (!range) return false;
          const height = range?.getBoundingClientRect().height || 0;
          s.scrollTop = direction === 'older' ? height + 80 : s.scrollHeight - height - s.clientHeight - 80;
          return true;
        }, direction);
        if (!hasRange) continue;
        for (let i = 0; i < 30 && inFlight === previous; i++) await page.waitForTimeout(100);
        await inFlight;
      }
    } finally {
      await inFlight;
      await context.storageState({ path: auth, indexedDB: true }); await fs.chmod(auth, 0o600);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await fs.mkdir('performance-results', { recursive: true });
  const path = `performance-results/trim-production-${Date.now()}.json`;
  await fs.writeFile(path, JSON.stringify(records, null, 2), { mode: 0o600 });
  console.log(path);
}
