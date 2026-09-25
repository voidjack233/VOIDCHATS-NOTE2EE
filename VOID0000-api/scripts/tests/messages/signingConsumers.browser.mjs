// Exercise the unchanged web viewer without editing web files or contacting production.
/* global window, document */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

const webRoot = fileURLToPath(new URL('../../../../VOID0000-www/', import.meta.url));
const requireWeb = createRequire(resolve(webRoot, 'package.json'));
const { createServer } = await import(requireWeb.resolve('vite'));
const { default: react } = await import(requireWeb.resolve('@vitejs/plugin-react'));
const { chromium } = requireWeb('playwright');
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import MessageOverlays from '/src/components/Chat/Messages/MessageOverlays.tsx';
const root = createRoot(document.getElementById('root'));
let session = 0;
window.openFixture = attachment => root.render(React.createElement(MessageOverlays, {
  contextMenu:null,emojiPickerTarget:null,selectedProfileId:null,selectedFriend:null,
  imageViewer:{sessionId:++session,attachments:[attachment],urls:[],index:0},
  onCloseImageViewer:()=>root.render(null),onPreviousImage:()=>{},onNextImage:()=>{},onSelectImageIndex:()=>{}
}));
window.downloadHref = null;
HTMLAnchorElement.prototype.click = function () { window.downloadHref = this.href; };
`;
const cacheDir = mkdtempSync(resolve(tmpdir(), 'void-signing-viewer-'));
const server = await createServer({ configFile: false, root: webRoot, appType: 'custom', cacheDir,
  plugins: [react(), { name: 'isolated-signing-consumer-fixture',
    resolveId: id => id === '/signing-consumers.js' ? '\0signing-consumers' : undefined,
    load: id => id === '\0signing-consumers' ? fixture : undefined }],
  server: { host: '127.0.0.1', port: 0, watch: null },
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'lucide-react', 'react-router-dom', 'blurhash'] } });
server.middlewares.use(async (req, res, next) => {
  if (req.url !== '/') return next();
  res.setHeader('Content-Type', 'text/html');
  res.end(await server.transformIndexHtml('/', '<html><body><div id="root"></div><script type="module" src="/signing-consumers.js"></script></body></html>'));
});
let browser;
try {
  await server.listen(); const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => console.error(error));
  const bytes = await sharp({ create: { width: 960, height: 640, channels: 3, background: '#526271' } }).jpeg().toBuffer();
  const requests = []; let failVmd = false;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/test-media/')) return route.continue();
    requests.push({ url: request.url(), type: request.resourceType() });
    return failVmd && !url.pathname.endsWith('/original') ? route.fulfill({ status: 503 })
      : route.fulfill({ contentType: 'image/jpeg', body: bytes });
  });
  await page.goto(origin); await page.waitForFunction(() => window.openFixture);
  const attachment = { id: '11111111-1111-4111-8111-111111111111', name: 'image.jpg', mime: 'image/jpeg', inline: true,
    url: `${origin}/test-media/original`, url_expires_at: Date.now() + 3600000,
    fallback_url: '/api/conversations/fixture/attachments/11111111-1111-4111-8111-111111111111',
    display_variants: Object.fromEntries([['small', 480], ['medium', 960], ['large', 1600]].map(([name, width]) =>
      [name, { url: `${origin}/test-media/${name}`, width, expires_at: Date.now() + 3600000 }])) };
  await page.evaluate(a => window.openFixture(a), attachment);
  await page.waitForFunction(() => document.querySelector('img[alt="image.jpg"]')?.naturalWidth > 0);
  const img = page.locator('img[alt="image.jpg"]');
  assert.match(await img.getAttribute('srcset'), /medium.*960w.*large.*1600w/);
  await page.getByRole('button', { name: /Download/i }).click();
  assert.equal(await page.evaluate(() => window.downloadHref), attachment.url);
  failVmd = true;
  const fallback = { ...attachment, display_variants: Object.fromEntries(Object.entries(attachment.display_variants)
    .map(([variant, value]) => [variant, { ...value, url: `${value.url}?retry=1` }])) };
  await page.evaluate(a => window.openFixture(a), fallback);
  await page.waitForFunction(url => {
    const img = document.querySelector('img[alt="image.jpg"]'); return img?.naturalWidth > 0 && img.currentSrc === url;
  }, attachment.url);
  assert.equal(requests.some(request => ['fetch', 'xhr'].includes(request.type)), false);
  console.log('PASS: actual viewer opens medium/large, Download selects original, VMD failure falls back to original, no media Fetch/XHR.');
} finally { await browser?.close(); await server.close(); rmSync(cacheDir, { recursive: true, force: true }); }
