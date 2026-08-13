#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installChatPerformanceCollector } from './chat-cls-lcp-browser.mjs';
import {
  aggregateScenarioResults,
  calculateCls,
  countImageAttachments,
  DEFAULT_RUNS,
  normalizeConversationRoute,
  parsePositiveInteger,
} from './chat-cls-lcp-core.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(SCRIPT_DIR, '../..');
const REPOSITORY_ROOT = path.resolve(WEB_ROOT, '..');
const LOCAL_STATE_DIR = path.join(WEB_ROOT, '.playwright');
const AUTH_STATE_PATH = path.resolve(
  WEB_ROOT,
  process.env.CHAT_PERF_AUTH_STATE || '.playwright/chat-perf-auth.json',
);
const LOCAL_CONFIG_PATH = path.resolve(
  WEB_ROOT,
  process.env.CHAT_PERF_CONFIG || '.playwright/chat-cls-lcp.local.json',
);
const RESULTS_ROOT = path.resolve(
  WEB_ROOT,
  process.env.CHAT_PERF_RESULTS_DIR || 'performance-results/chat-cls-lcp',
);
const DEFAULT_BASE_URL = 'https://void0000.online';
const TARGET_FIX_COMMIT = '44244edc7662da75654dd99d590a202c2922fd4d';
const MESSAGE_TIMELINE_SELECTOR = '[data-message-timeline]';
const MAX_POSITION_ATTEMPTS = 140;

const VIEWPORTS = {
  desktop: {
    viewport: { width: 1440, height: 900 },
    screen: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  mobile: {
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};

const SCENARIOS = [
  { name: 'latest-present', anchorKey: null },
  { name: 'historical-text-only', anchorKey: 'textOnly' },
  { name: 'historical-single-image', anchorKey: 'singleImage' },
  { name: 'historical-multi-image', anchorKey: 'multiImage' },
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(Number(value || 0) * factor) / factor;
};
const timestampForFile = () => new Date().toISOString().replace(/[:.]/g, '-');

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function resolveConfiguration({ requireRoute = false, requireAnchors = false } = {}) {
  const local = readJsonIfPresent(LOCAL_CONFIG_PATH);
  const baseUrl = String(process.env.CHAT_PERF_BASE_URL || local.baseUrl || DEFAULT_BASE_URL)
    .replace(/\/+$/, '');
  const conversationRoute = normalizeConversationRoute(
    process.env.CHAT_PERF_CONVERSATION_ROUTE || local.conversationRoute || null,
    baseUrl,
  );
  const anchors = {
    textOnly: process.env.CHAT_PERF_TEXT_MESSAGE_ID || local.anchors?.textOnly || null,
    singleImage: process.env.CHAT_PERF_SINGLE_IMAGE_MESSAGE_ID || local.anchors?.singleImage || null,
    multiImage: process.env.CHAT_PERF_MULTI_IMAGE_MESSAGE_ID || local.anchors?.multiImage || null,
  };
  if (requireRoute && !conversationRoute) {
    throw new Error(
      'Set CHAT_PERF_CONVERSATION_ROUTE to the deployed DM/group route before discovery',
    );
  }
  if (requireAnchors) {
    const missing = Object.entries(anchors).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length > 0) {
      throw new Error(`Run npm run perf:chat:discover first; missing anchors: ${missing.join(', ')}`);
    }
  }
  return {
    baseUrl,
    conversationRoute,
    conversationTitle: local.conversationTitle || null,
    anchors,
    anchorDetails: local.anchorDetails || {},
  };
}

function requireAuthState() {
  if (!fs.existsSync(AUTH_STATE_PATH)) {
    throw new Error(`Authentication state is missing. Run npm run perf:chat:auth first.`);
  }
}

function currentRevision() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  }).trim();
}

function fixCommitIsIncluded() {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', TARGET_FIX_COMMIT, 'HEAD'], {
      cwd: REPOSITORY_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function parseViewportNames() {
  const requested = (process.env.CHAT_PERF_VIEWPORTS || 'desktop,mobile')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const name of requested) {
    if (!VIEWPORTS[name]) throw new Error(`Unknown CHAT_PERF_VIEWPORTS value: ${name}`);
  }
  return [...new Set(requested)];
}

async function launchBrowser({ headed = false } = {}) {
  return chromium.launch({
    headless: !headed,
    args: ['--enable-features=SoftNavigationHeuristics'],
  });
}

async function captureAuthentication() {
  const config = resolveConfiguration();
  fs.mkdirSync(LOCAL_STATE_DIR, { recursive: true });
  const browser = await launchBrowser({ headed: process.env.CHAT_PERF_AUTH_HEADLESS !== '1' });
  const context = await browser.newContext({
    viewport: VIEWPORTS.desktop.viewport,
    screen: VIEWPORTS.desktop.screen,
  });
  const page = await context.newPage();

  try {
    await page.goto(`${config.baseUrl}/auth?view=login`, { waitUntil: 'domcontentloaded' });
    const identifier = process.env.CHAT_PERF_USERNAME;
    const password = process.env.CHAT_PERF_PASSWORD;
    if (identifier && password) {
      await page.locator('#identifier').fill(identifier);
      await page.locator('input[name="password"]').fill(password);
      await page.getByRole('button', { name: 'Sign In' }).click();
    } else {
      console.log('Complete login in the opened browser. Captcha/2FA can be completed normally.');
    }

    await page.waitForURL((url) => (
      url.origin === new URL(config.baseUrl).origin && url.pathname.startsWith('/chats')
    ), { timeout: 10 * 60_000 });
    await page.waitForTimeout(1_500);
    await context.storageState({ path: AUTH_STATE_PATH, indexedDB: true });
    fs.chmodSync(AUTH_STATE_PATH, 0o600);
    console.log(`Saved local auth state to ${AUTH_STATE_PATH}`);
  } finally {
    await browser.close();
  }
}

function isMessageHistoryUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /\/api\/conversations\/[^/]+\/messages$/.test(url.pathname);
  } catch {
    return false;
  }
}

function describeHistoryRequest(rawUrl) {
  const url = new URL(rawUrl);
  return {
    time: Date.now(),
    path: url.pathname,
    before: url.searchParams.get('before'),
    after: url.searchParams.get('after'),
    limit: url.searchParams.get('limit'),
    mode: url.searchParams.has('before')
      ? 'older'
      : url.searchParams.has('after')
        ? 'newer'
        : 'latest',
  };
}

function createPageTelemetry(page) {
  const telemetry = {
    messageRequests: [],
    messageCatalog: new Map(),
    consoleErrors: [],
    pageErrors: [],
  };

  page.on('request', (request) => {
    if (request.method() === 'GET' && isMessageHistoryUrl(request.url())) {
      telemetry.messageRequests.push(describeHistoryRequest(request.url()));
    }
  });
  page.on('response', async (response) => {
    if (response.request().method() !== 'GET' || !isMessageHistoryUrl(response.url())) return;
    try {
      const request = describeHistoryRequest(response.url());
      const payload = await response.json();
      for (const message of payload.messages || []) {
        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        const imageCount = countImageAttachments(attachments);
        const existing = telemetry.messageCatalog.get(String(message.message_id));
        telemetry.messageCatalog.set(String(message.message_id), {
          messageId: String(message.message_id),
          content: typeof message.content === 'string'
            ? message.content.trim().replace(/\s+/g, ' ').slice(0, 120)
            : '',
          attachmentCount: attachments.length,
          imageCount,
          sources: [...new Set([...(existing?.sources || []), request.mode])],
        });
      }
    } catch {
      // A failed/non-JSON response remains visible in the request/error report.
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') telemetry.consoleErrors.push(message.text().slice(0, 500));
  });
  page.on('pageerror', (error) => telemetry.pageErrors.push(error.message.slice(0, 500)));
  return telemetry;
}

async function createMeasuredContext(browser, viewportName) {
  const profile = VIEWPORTS[viewportName];
  const context = await browser.newContext({
    storageState: AUTH_STATE_PATH,
    viewport: profile.viewport,
    screen: profile.screen,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    colorScheme: 'dark',
    locale: 'en-US',
    serviceWorkers: 'block',
  });
  await context.addInitScript(installChatPerformanceCollector);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', {
    cacheDisabled: process.env.CHAT_PERF_DISABLE_CACHE !== '0',
  });
  const telemetry = createPageTelemetry(page);
  return { context, page, telemetry };
}

async function persistAuthenticatedState(context) {
  const hasAuthenticatedPage = context.pages().some((page) => {
    try {
      return new URL(page.url()).pathname.startsWith('/chats');
    } catch {
      return false;
    }
  });
  if (!hasAuthenticatedPage) return;
  await context.storageState({ path: AUTH_STATE_PATH, indexedDB: true });
  fs.chmodSync(AUTH_STATE_PATH, 0o600);
}

async function getTimelineSnapshot(page, reason = 'runner') {
  return page.evaluate((snapshotReason) => {
    if (window.__voidChatPerf) return window.__voidChatPerf.snapshot(snapshotReason);
    const timeline = document.querySelector('[data-message-timeline]');
    if (!(timeline instanceof HTMLElement)) return { mounted: false };
    return {
      mounted: true,
      scrollTop: timeline.scrollTop,
      scrollHeight: timeline.scrollHeight,
      clientHeight: timeline.clientHeight,
      bottomDistance: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
      rowCount: timeline.querySelectorAll('[data-message-id]').length,
    };
  }, reason);
}

async function waitForTimeline(page, timeoutMs = 20_000) {
  await page.locator(MESSAGE_TIMELINE_SELECTOR).waitFor({ state: 'attached', timeout: timeoutMs });
  await page.waitForFunction(() => {
    const timeline = document.querySelector('[data-message-timeline]');
    return timeline instanceof HTMLElement &&
      Number.parseFloat(getComputedStyle(timeline).opacity || '0') > 0 &&
      timeline.querySelectorAll('[data-message-id]').length > 0;
  }, undefined, { timeout: timeoutMs });
}

async function waitForTimelineStable(page, {
  stableMs = 900,
  timeoutMs = 15_000,
} = {}) {
  await waitForTimeline(page, timeoutMs);
  const startedAt = Date.now();
  let stableSince = 0;
  let previousSignature = null;
  let latest = null;

  while (Date.now() - startedAt < timeoutMs) {
    latest = await getTimelineSnapshot(page, 'settle');
    const signature = JSON.stringify({
      scrollTop: round(latest.scrollTop, 0),
      scrollHeight: round(latest.scrollHeight, 0),
      topVisibleMessageId: latest.topVisibleMessageId,
      topVisibleMessageOffset: round(latest.topVisibleMessageOffset, 0),
      rowCount: latest.rowCount,
      pendingVisibleImages: latest.pendingVisibleImages,
      opacity: latest.opacity,
    });
    const ready = latest.pendingVisibleImages === 0 && latest.opacity !== '0';
    if (ready && signature === previousSignature) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return latest;
    } else {
      stableSince = 0;
    }
    previousSignature = signature;
    await sleep(100);
  }
  throw new Error(`Message timeline did not stabilize within ${timeoutMs}ms`);
}

async function navigateSpaAsUser(page, route) {
  const navigationId = `void-chat-perf-nav-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await page.evaluate(({ id, destination }) => {
    document.getElementById(id)?.remove();
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = 'performance navigation';
    Object.assign(button.style, {
      position: 'fixed',
      left: '1px',
      top: '1px',
      width: '2px',
      height: '2px',
      opacity: '0.01',
      zIndex: '2147483647',
    });
    button.addEventListener('click', () => {
      history.pushState({}, '', destination);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      setTimeout(() => button.remove(), 0);
    }, { once: true });
    document.body.appendChild(button);
  }, { id: navigationId, destination: route });
  await page.locator(`#${navigationId}`).click({ force: true });
  await page.waitForFunction((destination) => (
    `${location.pathname}${location.search}` === destination
  ), route, { timeout: 15_000 });
}

async function ensurePresent(page) {
  const jumpButton = page.getByRole('button', { name: 'Jump to Present' });
  if (await jumpButton.isVisible().catch(() => false)) {
    await jumpButton.click();
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.evaluate(() => {
      const timeline = document.querySelector('[data-message-timeline]');
      if (!(timeline instanceof HTMLElement)) return;
      timeline.scrollTop = timeline.scrollHeight;
      timeline.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await sleep(250);
    const snapshot = await getTimelineSnapshot(page, 'ensure-present');
    if (!snapshot.newerRange && snapshot.bottomDistance <= 4) {
      return waitForTimelineStable(page);
    }
  }
  throw new Error('Could not reach the latest message window');
}

async function centerMessage(page, messageId) {
  return page.evaluate((targetId) => {
    const timeline = document.querySelector('[data-message-timeline]');
    const row = [...document.querySelectorAll('[data-message-id]')]
      .find((element) => element.getAttribute('data-message-id') === targetId);
    if (!(timeline instanceof HTMLElement) || !(row instanceof HTMLElement)) return false;
    row.scrollIntoView({ block: 'center', inline: 'nearest' });
    timeline.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  }, String(messageId));
}

async function getMessageViewportAnchor(page, messageId) {
  return page.evaluate((targetId) => {
    const timeline = document.querySelector('[data-message-timeline]');
    const row = [...document.querySelectorAll('[data-message-id]')]
      .find((element) => element.getAttribute('data-message-id') === targetId);
    if (!(timeline instanceof HTMLElement) || !(row instanceof HTMLElement)) return null;
    const timelineRect = timeline.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      messageId: targetId,
      offsetPx: rowRect.top - timelineRect.top,
      visible: rowRect.bottom > timelineRect.top && rowRect.top < timelineRect.bottom,
    };
  }, String(messageId));
}

async function positionAtHistoricalMessage(page, messageId) {
  for (let attempt = 0; attempt < MAX_POSITION_ATTEMPTS; attempt += 1) {
    if (await centerMessage(page, messageId)) {
      await waitForTimelineStable(page);
      const snapshot = await getTimelineSnapshot(page, 'historical-position');
      return {
        ...snapshot,
        targetAnchor: await getMessageViewportAnchor(page, messageId),
      };
    }

    await page.evaluate(() => {
      const timeline = document.querySelector('[data-message-timeline]');
      if (!(timeline instanceof HTMLElement)) return;
      const distance = Math.max(320, timeline.clientHeight * 0.82);
      timeline.scrollTop = Math.max(0, timeline.scrollTop - distance);
      timeline.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await sleep(300);
  }
  throw new Error(`Could not load historical message ${messageId}`);
}

function findDiscoveredAnchors(catalog) {
  const historical = [...catalog.values()].filter((message) => message.sources.includes('older'));
  const textOnly = historical.find((message) => (
    message.attachmentCount === 0 && message.content.length > 0
  ));
  const singleImage = historical.find((message) => (
    message.attachmentCount === 1 && message.imageCount === 1
  ));
  const multiImage = historical.find((message) => message.imageCount >= 2);
  return { textOnly, singleImage, multiImage };
}

async function discoverScenarios() {
  requireAuthState();
  const config = resolveConfiguration({ requireRoute: true });
  const browser = await launchBrowser();
  const { context, page, telemetry } = await createMeasuredContext(browser, 'desktop');
  try {
    await page.goto(`${config.baseUrl}${config.conversationRoute}`, {
      waitUntil: 'domcontentloaded',
    });
    await waitForTimelineStable(page);
    await ensurePresent(page);

    let found = findDiscoveredAnchors(telemetry.messageCatalog);
    const maxSteps = parsePositiveInteger(
      process.env.CHAT_PERF_DISCOVERY_STEPS,
      120,
      'CHAT_PERF_DISCOVERY_STEPS',
      500,
    );
    for (let step = 0; step < maxSteps && Object.values(found).some((value) => !value); step += 1) {
      await page.evaluate(() => {
        const timeline = document.querySelector('[data-message-timeline]');
        if (!(timeline instanceof HTMLElement)) return;
        timeline.scrollTop = Math.max(0, timeline.scrollTop - Math.max(360, timeline.clientHeight * 0.8));
        timeline.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      await sleep(350);
      found = findDiscoveredAnchors(telemetry.messageCatalog);
    }

    const missing = Object.entries(found).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length > 0) {
      throw new Error(
        `The selected conversation does not expose all required historical cases: ${missing.join(', ')}`,
      );
    }
    const title = await page.locator('[data-chat-conversation-header] h1').textContent();
    const saved = {
      baseUrl: config.baseUrl,
      conversationRoute: config.conversationRoute,
      conversationTitle: title?.trim() || null,
      anchors: Object.fromEntries(
        Object.entries(found).map(([key, value]) => [key, value.messageId]),
      ),
      anchorDetails: found,
      discoveredAt: new Date().toISOString(),
      discoveryRequestCount: telemetry.messageRequests.length,
    };
    writeJson(LOCAL_CONFIG_PATH, saved);
    console.log(`Saved local scenario configuration to ${LOCAL_CONFIG_PATH}`);
    console.table(Object.entries(found).map(([scenario, message]) => ({
      scenario,
      messageId: message.messageId,
      images: message.imageCount,
      attachments: message.attachmentCount,
      preview: message.content,
    })));
  } finally {
    await persistAuthenticatedState(context);
    await context.close();
    await browser.close();
  }
}

function selectLargestPaint(paints) {
  return [...paints].sort((left, right) => (
    (right?.size || 0) - (left?.size || 0) ||
    (right?.presentationTime || right?.startTime || 0) -
      (left?.presentationTime || left?.startTime || 0)
  ))[0] || null;
}

function extractMetricWindow(raw, {
  startTime,
  endTime,
  route,
  hardNavigation = false,
}) {
  let softNavigation = null;
  if (!hardNavigation) {
    softNavigation = raw.softNavigations
      .filter((entry) => {
        if (entry.startTime < startTime - 100 || entry.startTime > endTime) return false;
        try {
          return new URL(entry.name).pathname === new URL(route, DEFAULT_BASE_URL).pathname;
        } catch {
          return false;
        }
      })
      .at(-1) || null;
  }

  const shifts = raw.layoutShifts.filter((entry) => (
    entry.startTime >= startTime && entry.startTime <= endTime + 100 &&
    (!softNavigation?.navigationId ||
      !entry.navigationId ||
      entry.navigationId === softNavigation.navigationId)
  ));
  const validShifts = shifts.filter((entry) => !entry.hadRecentInput);
  const largestShift = [...validShifts].sort((left, right) => right.value - left.value)[0] || null;
  const largestShiftIncludingInput = [...shifts].sort((left, right) => right.value - left.value)[0] || null;

  let lcp = null;
  if (hardNavigation) {
    const paint = selectLargestPaint(raw.hardLcps.filter((entry) => entry.startTime <= endTime));
    if (paint) {
      lcp = { kind: 'hard-navigation', durationMs: paint.startTime, ...paint };
    }
  } else if (softNavigation) {
    const matchingPaints = raw.interactionPaints
      .filter((entry) => entry.interactionId === softNavigation.interactionId)
      .map((entry) => entry.largestContentfulPaint)
      .filter(Boolean);
    if (softNavigation.initialLargestContentfulPaint) {
      matchingPaints.push(softNavigation.initialLargestContentfulPaint);
    }
    const paint = selectLargestPaint(matchingPaints);
    if (paint) {
      const presentationTime = paint.presentationTime || paint.renderTime || paint.startTime;
      lcp = {
        kind: 'soft-navigation',
        durationMs: round(presentationTime - softNavigation.startTime),
        ...paint,
      };
    }
  }

  const timelineSamples = raw.timelineSamples.filter((entry) => (
    entry.time >= startTime && entry.time <= endTime
  ));
  let maximumScrollDeltaPx = 0;
  let previous = null;
  for (const sample of timelineSamples) {
    if (sample.mounted && previous?.mounted) {
      maximumScrollDeltaPx = Math.max(
        maximumScrollDeltaPx,
        Math.abs(sample.scrollTop - previous.scrollTop),
      );
    }
    previous = sample;
  }

  return {
    cls: round(calculateCls(shifts), 5),
    rawShiftTotal: round(shifts.reduce((total, entry) => total + entry.value, 0), 5),
    layoutShifts: shifts,
    largestShift,
    largestShiftIncludingInput,
    lcp,
    softNavigation,
    maximumScrollDeltaPx: round(maximumScrollDeltaPx),
    timelineSamples,
  };
}

function compareAnchors(before, after, scenario, targetMessageId = null) {
  if (scenario === 'latest-present') {
    return {
      expected: 'bottom',
      preserved: after.bottomDistance <= 4,
      beforeMessageId: before.topVisibleMessageId || null,
      afterMessageId: after.topVisibleMessageId || null,
      offsetDeltaPx: 0,
      bottomDistancePx: after.bottomDistance,
    };
  }
  if (targetMessageId) {
    const beforeAnchor = before.targetAnchor;
    const afterAnchor = after.targetAnchor;
    const sameMessage = Boolean(
      beforeAnchor?.messageId && beforeAnchor.messageId === afterAnchor?.messageId,
    );
    const offsetDeltaPx = sameMessage
      ? Math.abs(Number(afterAnchor.offsetPx) - Number(beforeAnchor.offsetPx))
      : null;
    return {
      expected: 'historical-target',
      preserved: sameMessage && beforeAnchor.visible && afterAnchor.visible && offsetDeltaPx <= 12,
      beforeMessageId: beforeAnchor?.messageId || null,
      afterMessageId: afterAnchor?.messageId || null,
      beforeOffsetPx: beforeAnchor ? round(beforeAnchor.offsetPx) : null,
      afterOffsetPx: afterAnchor ? round(afterAnchor.offsetPx) : null,
      offsetDeltaPx: offsetDeltaPx === null ? null : round(offsetDeltaPx),
      bottomDistancePx: after.bottomDistance,
    };
  }
  const sameMessage = Boolean(
    before.topVisibleMessageId && before.topVisibleMessageId === after.topVisibleMessageId,
  );
  const offsetDeltaPx = sameMessage
    ? Math.abs((after.topVisibleMessageOffset || 0) - (before.topVisibleMessageOffset || 0))
    : null;
  return {
    expected: 'historical-anchor',
    preserved: sameMessage && offsetDeltaPx <= 12,
    beforeMessageId: before.topVisibleMessageId || null,
    afterMessageId: after.topVisibleMessageId || null,
    offsetDeltaPx: offsetDeltaPx === null ? null : round(offsetDeltaPx),
    bottomDistancePx: after.bottomDistance,
  };
}

async function runRestoreScenario({
  page,
  config,
  viewportName,
  runNumber,
  scenario,
}) {
  const targetMessageId = scenario.anchorKey ? config.anchors[scenario.anchorKey] : null;
  const before = targetMessageId
    ? await positionAtHistoricalMessage(page, targetMessageId)
    : await ensurePresent(page);

  await navigateSpaAsUser(page, '/chats');
  await page.locator(MESSAGE_TIMELINE_SELECTOR).waitFor({ state: 'detached', timeout: 15_000 });
  await sleep(250);

  const startTime = await page.evaluate((label) => window.__voidChatPerf.startWindow(label), scenario.name);
  await navigateSpaAsUser(page, config.conversationRoute);
  const afterSnapshot = await waitForTimelineStable(page);
  const after = targetMessageId
    ? {
        ...afterSnapshot,
        targetAnchor: await getMessageViewportAnchor(page, targetMessageId),
      }
    : afterSnapshot;
  await sleep(500);
  const endTime = await page.evaluate((label) => window.__voidChatPerf.endWindow(label), scenario.name);
  const raw = await page.evaluate(() => window.__voidChatPerf.export());
  const metrics = extractMetricWindow(raw, {
    startTime,
    endTime,
    route: config.conversationRoute,
  });
  const anchor = compareAnchors(before, after, scenario.name, targetMessageId);
  const failures = [];
  if (!metrics.softNavigation) failures.push('soft navigation was not detected');
  if (!metrics.lcp) failures.push('soft-navigation LCP was not emitted');
  if (!anchor.preserved) failures.push('restored viewport anchor was not preserved');
  if (targetMessageId) {
    const targetPresent = await page.evaluate((messageId) => (
      [...document.querySelectorAll('[data-message-id]')]
        .some((row) => row.getAttribute('data-message-id') === messageId)
    ), targetMessageId);
    if (!targetPresent) failures.push(`target message ${targetMessageId} is not rendered after restore`);
  }

  return {
    viewport: viewportName,
    scenario: scenario.name,
    run: runNumber,
    targetMessageId,
    startTime,
    endTime,
    cls: metrics.cls,
    rawShiftTotal: metrics.rawShiftTotal,
    lcp: metrics.lcp,
    largestShift: metrics.largestShift,
    largestShiftIncludingInput: metrics.largestShiftIncludingInput,
    individualLayoutShifts: metrics.layoutShifts,
    maximumScrollDeltaPx: metrics.maximumScrollDeltaPx,
    anchor,
    failures,
  };
}

async function waitForHistoryRequest(telemetry, mode, previousCount, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const matching = telemetry.messageRequests.filter((request) => request.mode === mode);
    if (matching.length > previousCount) return matching.at(-1);
    await sleep(50);
  }
  return null;
}

async function scrollToBoundary(page, edge) {
  await page.evaluate((targetEdge) => {
    const timeline = document.querySelector('[data-message-timeline]');
    if (!(timeline instanceof HTMLElement)) return;
    timeline.scrollTop = targetEdge === 'top' ? 0 : timeline.scrollHeight;
    timeline.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, edge);
}

async function getBoundaryMessageAnchor(page, edge, messageId = null) {
  return page.evaluate(({ targetEdge, targetMessageId }) => {
    const timeline = document.querySelector('[data-message-timeline]');
    if (!(timeline instanceof HTMLElement)) return null;
    const rows = [...timeline.querySelectorAll('[data-message-id]')];
    const row = targetMessageId
      ? rows.find((candidate) => candidate.getAttribute('data-message-id') === targetMessageId)
      : targetEdge === 'top'
        ? rows[0]
        : rows.at(-1);
    if (!(row instanceof HTMLElement)) return null;
    return {
      messageId: row.getAttribute('data-message-id'),
      offsetPx: row.getBoundingClientRect().top - timeline.getBoundingClientRect().top,
    };
  }, { targetEdge: edge, targetMessageId: messageId });
}

function compareBoundaryMessageAnchors(before, after) {
  const sameMessage = Boolean(before?.messageId && before.messageId === after?.messageId);
  const offsetDeltaPx = sameMessage
    ? Math.abs(Number(after.offsetPx) - Number(before.offsetPx))
    : null;
  return {
    preserved: sameMessage && offsetDeltaPx <= 16,
    beforeMessageId: before?.messageId || null,
    afterMessageId: after?.messageId || null,
    offsetDeltaPx: offsetDeltaPx === null ? null : round(offsetDeltaPx),
  };
}

function findTrimEvent(rowCounts) {
  for (let index = 1; index < rowCounts.length; index += 1) {
    if (rowCounts[index - 1] >= 80 && rowCounts[index] <= 60) {
      return { before: rowCounts[index - 1], after: rowCounts[index] };
    }
  }
  return null;
}

async function runRuntimeContracts(browser, config, viewportName) {
  const { context, page, telemetry } = await createMeasuredContext(browser, viewportName);
  const initialRowCounts = [];
  const olderRowCounts = [];
  const newerRowCounts = [];
  const olderAnchors = [];
  const newerAnchors = [];
  let symmetricSkeleton = false;
  let jumpToPresentVisible = false;
  let jumpToPresentWorked = false;
  let atPresentPinning = false;

  try {
    await page.goto(`${config.baseUrl}${config.conversationRoute}`, { waitUntil: 'domcontentloaded' });
    await waitForTimelineStable(page);
    await ensurePresent(page);
    initialRowCounts.push((await getTimelineSnapshot(page, 'contract-present')).rowCount);

    for (let iteration = 0; iteration < 7; iteration += 1) {
      const priorRequests = telemetry.messageRequests.filter((request) => request.mode === 'older').length;
      await scrollToBoundary(page, 'top');
      const before = await getBoundaryMessageAnchor(page, 'top');
      const request = await waitForHistoryRequest(telemetry, 'older', priorRequests);
      if (!request) break;
      const after = await waitForTimelineStable(page, { stableMs: 500 });
      olderRowCounts.push(after.rowCount);
      const restored = await getBoundaryMessageAnchor(page, 'top', before?.messageId);
      olderAnchors.push(compareBoundaryMessageAnchors(before, restored));
      symmetricSkeleton ||= after.olderSkeleton && after.newerSkeleton;
    }

    jumpToPresentVisible = await page.getByRole('button', { name: 'Jump to Present' })
      .isVisible().catch(() => false);

    for (let iteration = 0; iteration < 7; iteration += 1) {
      const priorRequests = telemetry.messageRequests.filter((request) => request.mode === 'newer').length;
      await scrollToBoundary(page, 'bottom');
      const before = await getBoundaryMessageAnchor(page, 'bottom');
      const request = await waitForHistoryRequest(telemetry, 'newer', priorRequests);
      if (!request) break;
      const after = await waitForTimelineStable(page, { stableMs: 500 });
      newerRowCounts.push(after.rowCount);
      const restored = await getBoundaryMessageAnchor(page, 'bottom', before?.messageId);
      newerAnchors.push(compareBoundaryMessageAnchors(before, restored));
      symmetricSkeleton ||= after.olderSkeleton && after.newerSkeleton;
    }

    const jumpButton = page.getByRole('button', { name: 'Jump to Present' });
    if (await jumpButton.isVisible().catch(() => false)) await jumpButton.click();
    const present = await ensurePresent(page);
    jumpToPresentWorked = present.bottomDistance <= 4 && !present.newerRange;

    const originalViewport = VIEWPORTS[viewportName].viewport;
    await page.setViewportSize({
      width: originalViewport.width,
      height: Math.max(520, originalViewport.height - 120),
    });
    await waitForTimelineStable(page, { stableMs: 500 });
    await page.setViewportSize(originalViewport);
    const resized = await waitForTimelineStable(page, { stableMs: 500 });
    atPresentPinning = resized.bottomDistance <= 4;

    const paginationRequests = telemetry.messageRequests.filter((request) => (
      request.mode === 'older' || request.mode === 'newer'
    ));
    const olderTrim = findTrimEvent([...initialRowCounts, ...olderRowCounts]);
    const newerTrim = findTrimEvent([
      olderRowCounts.at(-1) || initialRowCounts.at(-1),
      ...newerRowCounts,
    ]);
    return {
      viewport: viewportName,
      passed: null,
      olderPagination: paginationRequests.some((request) => request.mode === 'older'),
      newerPagination: paginationRequests.some((request) => request.mode === 'newer'),
      pageSize20: paginationRequests.length > 0 &&
        paginationRequests.every((request) => request.limit === '20'),
      trimTrigger80Target60: Boolean(olderTrim),
      topTrimming: Boolean(olderTrim),
      bottomTrimming: Boolean(newerTrim) || paginationRequests.some((request) => request.mode === 'newer'),
      symmetricHistorySkeleton: symmetricSkeleton,
      jumpToPresentVisible,
      jumpToPresentWorked,
      historicalAnchorPreserved: olderAnchors.some((anchor) => anchor.preserved) ||
        newerAnchors.some((anchor) => anchor.preserved),
      atPresentBottomPinning: atPresentPinning,
      rowCounts: {
        initial: initialRowCounts,
        older: olderRowCounts,
        newer: newerRowCounts,
      },
      olderTrim,
      newerTrim,
      olderAnchorChecks: olderAnchors,
      newerAnchorChecks: newerAnchors,
      historyRequests: paginationRequests,
      consoleErrors: telemetry.consoleErrors,
      pageErrors: telemetry.pageErrors,
    };
  } finally {
    await persistAuthenticatedState(context);
    await context.close();
  }
}

function finalizeContractStatus(contract) {
  const required = [
    'olderPagination',
    'newerPagination',
    'pageSize20',
    'trimTrigger80Target60',
    'topTrimming',
    'bottomTrimming',
    'symmetricHistorySkeleton',
    'jumpToPresentVisible',
    'jumpToPresentWorked',
    'historicalAnchorPreserved',
    'atPresentBottomPinning',
  ];
  return { ...contract, passed: required.every((key) => contract[key] === true) };
}

async function runPerformanceRegression() {
  requireAuthState();
  const config = resolveConfiguration({ requireRoute: true, requireAnchors: true });
  const runs = parsePositiveInteger(process.env.CHAT_PERF_RUNS, DEFAULT_RUNS, 'CHAT_PERF_RUNS', 20);
  const viewportNames = parseViewportNames();
  const resultDirectory = path.join(RESULTS_ROOT, timestampForFile());
  fs.mkdirSync(resultDirectory, { recursive: true });
  const browser = await launchBrowser();
  const results = [];
  const contracts = [];
  const browserVersion = browser.version();

  try {
    if (process.env.CHAT_PERF_SKIP_CONTRACTS !== '1') {
      for (const viewportName of viewportNames) {
        console.log(`Checking timeline contracts (${viewportName})...`);
        contracts.push(finalizeContractStatus(
          await runRuntimeContracts(browser, config, viewportName),
        ));
      }
    }

    for (const viewportName of viewportNames) {
      const { context, page, telemetry } = await createMeasuredContext(browser, viewportName);
      try {
        for (let runNumber = 1; runNumber <= runs; runNumber += 1) {
          console.log(`[${viewportName}] repeat ${runNumber}/${runs}`);
          await page.goto(`${config.baseUrl}${config.conversationRoute}`, {
            waitUntil: 'domcontentloaded',
          });
          const hardEndSnapshot = await waitForTimelineStable(page);
          await sleep(500);
          const hardRaw = await page.evaluate(() => window.__voidChatPerf.export());
          const hardEndTime = await page.evaluate(() => performance.now());
          const hardMetrics = extractMetricWindow(hardRaw, {
            startTime: 0,
            endTime: hardEndTime,
            route: config.conversationRoute,
            hardNavigation: true,
          });
          results.push({
            viewport: viewportName,
            scenario: 'hard-reload-present',
            run: runNumber,
            cls: hardMetrics.cls,
            rawShiftTotal: hardMetrics.rawShiftTotal,
            lcp: hardMetrics.lcp,
            largestShift: hardMetrics.largestShift,
            individualLayoutShifts: hardMetrics.layoutShifts,
            maximumScrollDeltaPx: hardMetrics.maximumScrollDeltaPx,
            anchor: {
              expected: 'bottom',
              preserved: hardEndSnapshot.bottomDistance <= 4,
              offsetDeltaPx: 0,
              bottomDistancePx: hardEndSnapshot.bottomDistance,
            },
            failures: hardMetrics.lcp ? [] : ['hard-navigation LCP was not emitted'],
          });

          for (const scenario of SCENARIOS) {
            const result = await runRestoreScenario({
              page,
              config,
              viewportName,
              runNumber,
              scenario,
            });
            results.push(result);
            if (result.failures.length > 0) {
              const screenshotPath = path.join(
                resultDirectory,
                `${viewportName}-${scenario.name}-run-${runNumber}.png`,
              );
              await page.screenshot({ path: screenshotPath, fullPage: false });
            }
          }
        }
      } finally {
        await persistAuthenticatedState(context);
        await context.close();
      }
      if (telemetry.pageErrors.length > 0) {
        console.warn(`[${viewportName}] page errors:`, telemetry.pageErrors);
      }
    }
  } finally {
    await browser.close();
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    revision: currentRevision(),
    targetFixCommit: TARGET_FIX_COMMIT,
    targetFixIncluded: fixCommitIsIncluded(),
    deployedUrl: `${config.baseUrl}${config.conversationRoute}`,
    browser: { name: 'Chromium', version: browserVersion },
    methodology: {
      repeats: runs,
      viewports: viewportNames.map((name) => ({ name, ...VIEWPORTS[name] })),
      browserCacheDisabled: process.env.CHAT_PERF_DISABLE_CACHE !== '0',
      hardReloadMetric: 'standard largest-contentful-paint and layout-shift entries',
      conversationRestoreMetric:
        'Chrome soft-navigation plus interaction-contentful-paint and sliced layout-shift entries',
      note:
        'Historical position is an in-memory conversation runtime, so historical cases use a real SPA route-away/route-back restore rather than F5, which intentionally opens latest.',
    },
    anchors: config.anchorDetails,
    contracts,
    aggregates: aggregateScenarioResults(results),
    results,
  };
  const reportPath = path.join(resultDirectory, 'chat-cls-lcp-report.json');
  writeJson(reportPath, report);
  console.log(`\nReport: ${reportPath}`);
  console.table(report.aggregates.map((summary) => ({
    viewport: summary.viewport,
    scenario: summary.scenario,
    samples: summary.samples,
    medianCLS: summary.cls.median,
    worstCLS: summary.cls.maximum,
    medianLCPms: summary.lcpMs.median,
    worstLCPms: summary.lcpMs.maximum,
    failures: summary.failures.length,
  })));
  if (contracts.length > 0) {
    console.table(contracts.map((contract) => ({
      viewport: contract.viewport,
      passed: contract.passed,
      older: contract.olderPagination,
      newer: contract.newerPagination,
      page20: contract.pageSize20,
      trim80to60: contract.trimTrigger80Target60,
      symmetricSkeleton: contract.symmetricHistorySkeleton,
      jumpPresent: contract.jumpToPresentWorked,
      historicalAnchor: contract.historicalAnchorPreserved,
      bottomPin: contract.atPresentBottomPinning,
    })));
  }
}

async function main() {
  const command = process.argv[2] || 'run';
  if (command === 'auth') return captureAuthentication();
  if (command === 'discover') return discoverScenarios();
  if (command === 'run') return runPerformanceRegression();
  throw new Error(`Unknown command: ${command}. Use auth, discover, or run.`);
}

main().catch((error) => {
  console.error(`Chat CLS/LCP regression failed: ${error.message}`);
  process.exitCode = 1;
});
