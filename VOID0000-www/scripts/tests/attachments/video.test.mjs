import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

test('browser video drafts use independent binary ingests, preserve failures and reject account-switch work', { timeout: 90000 }, async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), appType: 'custom', plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'lucide-react', 'blurhash'] },
    server: { host: '127.0.0.1', port: 0, watch: null } });
  server.middlewares.use((req, res, next) => {
    if (req.url !== '/') return next();
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated video tests</title>');
  });
  let browser;
  try {
    await server.listen(); const origin = server.resolvedUrls.local[0]; browser = await chromium.launch(); const page = await browser.newPage();
    const requests = []; const ingests = new Map(); let switchAtStatus = false;
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (!req.url().startsWith(origin)) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      requests.push({ path: url.pathname, method: req.method(), headers: req.headers(), bytes: req.postDataBuffer() });
      if (url.pathname === '/api/csrf/csrf-token') return route.fulfill({ json: { success: true, csrfToken: 'fixture-csrf' } });
      if (req.method() === 'DELETE') return route.fulfill({ status: 204 });
      if (req.method() === 'POST' && url.pathname.endsWith('/attachments')) {
        assert.equal(req.headers()['content-type'], 'application/octet-stream');
        assert.equal(req.headers()['x-csrf-token'], 'fixture-csrf');
        const mime = req.headers()['x-attachment-mime'];
        return route.fulfill({ json: { success: true, urls: [`/api/conversations/c/attachments/file-${requests.length}`],
          attachments: [{ mime, size: req.postDataBuffer().length, ...(mime === 'image/png' ? { width: 2, height: 2 } : {}) }] } });
      }
      if (req.method() === 'POST') {
        const id = req.headers()['x-media-ingest-id']; assert.ok(id); assert.equal(req.headers()['content-type'], 'application/octet-stream');
        assert.equal(req.headers()['x-csrf-token'], 'fixture-csrf');
        ingests.set(id, { bytes: req.postDataBuffer(), reads: 0 });
        return route.fulfill({ status: 202, json: { success: true, ingest_id: id, status: 'queued' } });
      }
      const id = url.pathname.split('/').at(-1), ingest = ingests.get(id); assert.ok(ingest);
      if (switchAtStatus) {
        await page.evaluate(async () => (await import('/src/Services/Auth/client/authOperationScope.ts')).setAuthOperationAccount('b'));
        return route.fulfill({ json: { status: 'queued' } });
      }
      if (ingest.bytes.toString() === 'invalid') return route.fulfill({ json: { status: 'failed', error_code: 'MEDIA_PROCESS_FAILED' } });
      return route.fulfill({ json: ++ingest.reads === 1 ? { status: 'queued' } : { status: 'ready', attachment: {
        url: `/api/conversations/c/attachments/${id}`, mime: 'video/mp4', width: 320, height: 180, duration_ms: 1000, size: 123,
      } } });
    });
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const scope = await import('/src/Services/Auth/client/authOperationScope.ts'); scope.setAuthOperationAccount('a');
      const { uploadVideo } = await import('/src/Services/Chat/videoUploadService.ts');
      const labels = [[], []];
      const results = await Promise.all([0,1].map(index => uploadVideo('c', new File([new Uint8Array([0,255,index,13,10])], `video${index}.mp4`, { type: 'video/mp4' }), { onVideoStatus: label => labels[index].push(label) })));
      let failed = false; try { await uploadVideo('c', new File(['invalid'],'broken.mp4')); } catch { failed=true; }
      let cancelled = true; try { await uploadVideo('c', new File(['not sent'],'cancelled.mp4'), { shouldCancel: () => true }); cancelled=false; } catch { /* Expected. */ }
      return { results, labels, failed, cancelled };
    });
    assert.equal(result.results.length, 2); assert.notEqual(result.results[0].url, result.results[1].url);
    assert.ok(result.labels.every(labels => labels.includes('Waiting to process...') && labels.at(-1) === 'Ready'));
    assert.equal(result.failed, true); assert.equal(result.cancelled, true);
    const uploads = requests.filter(r => r.method === 'POST'); assert.equal(uploads.length,3);
    assert.deepEqual(uploads[0].bytes, Buffer.from([0,255,0,13,10])); assert.deepEqual(uploads[1].bytes, Buffer.from([0,255,1,13,10]));
    const mixed = await page.evaluate(async () => {
      const { uploadAttachments } = await import('/src/Services/Chat/messageService.ts');
      const { parseAttachments, serializeAttachments } = await import('/src/Services/Chat/messageAttachments.ts');
      const { looksLikeImageAttachment, isVideoAttachmentLayout } = await import('/src/components/Chat/Attachments/messageAttachmentLayout.ts');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const files = [new File(['video-one'], 'one.mp4', { type: 'video/mp4' }), new File([png], 'image.png', { type: 'image/png' }),
        new File(['hello'], 'note.txt', { type: 'text/plain' }), new File(['video-two'], 'two.mp4', { type: 'video/mp4' })];
      const attachments = parseAttachments(await uploadAttachments('c', files));
      return { attachments: parseAttachments(serializeAttachments(attachments)),
        images: attachments.map(looksLikeImageAttachment), videos: attachments.map(isVideoAttachmentLayout) };
    });
    assert.deepEqual(mixed.attachments.map(a => a.mime), ['video/mp4', 'image/png', 'text/plain', 'video/mp4']);
    assert.equal(new Set(mixed.attachments.map(a => a.url)).size, 4);
    assert.deepEqual(mixed.images, [false, true, false, false]);
    assert.deepEqual(mixed.videos, [true, false, false, true]);
    assert.ok(mixed.attachments.filter(a => a.mime === 'video/mp4').every(a => a.duration_ms === 1000));
    switchAtStatus = true;
    const error = await page.evaluate(async () => {
      const { uploadVideo } = await import('/src/Services/Chat/videoUploadService.ts');
      try { await uploadVideo('c',new File(['account a'],'a.mp4')); return null; } catch(error) { return error.code; }
    });
    assert.equal(error, 'AUTH_ACCOUNT_CHANGED');
    assert.equal(requests.some(r => r.headers['x-void-account-id'] === 'b'), false);
  } finally { await browser?.close(); await server.close(); }
});

test('native video element keeps geometry, has no autoplay, and falls back once without render Fetch', { timeout: 90000 }, async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), appType: 'custom', plugins: [react(), {
    name: 'video-component-fixture',
    resolveId(id) { if (id === '/media-harness.tsx') return '\0media-harness'; },
    load(id) { if (id === '\0media-harness') return `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import Player from '/src/components/Chat/Attachments/AttachmentVideoPlayer.tsx';
      const root=createRoot(document.getElementById('root'));
      window.renderVideo=(attachment)=>root.render(React.createElement(Player,{attachment}));
    `; },
  }], optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'lucide-react', 'blurhash'] },
    server: { host: '127.0.0.1', port: 0, watch: null } });
  server.middlewares.use(async (req,res,next) => {
    if (req.url !== '/') return next(); res.setHeader('Content-Type','text/html');
    // Only utility styles used by the isolated component, no test layout machinery.
    res.end(await server.transformIndexHtml('/', '<!doctype html><style>.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}.h-full{height:100%}.w-full{width:100%}</style><div id="root"></div><script type="module" src="/media-harness.tsx"></script>'));
  });
  let browser;
  try {
    await server.listen();const origin=server.resolvedUrls.local[0];browser=await chromium.launch();const page=await browser.newPage();
    const renderRequests=[];
    await page.route('**/*', route => {
      if (!route.request().url().startsWith(origin)) return route.abort();
      if (/\/(test-media|api\/conversations)/.test(new URL(route.request().url()).pathname)) {
        renderRequests.push(route.request().resourceType()); return route.fulfill({status:404});
      }
      return route.continue();
    });
    await page.goto(origin);await page.waitForFunction(()=>Boolean(window.renderVideo));
    const attachment={id:'video',url:`${origin}test-media/source.mp4`,fallback_url:'/api/conversations/c/attachments/video',mime:'video/mp4',video_trusted:true,inline:true,width:640,height:360};
    await page.evaluate(a=>window.renderVideo(a),attachment);const video=page.locator('video');await video.waitFor();
    assert.equal(await video.getAttribute('preload'),'none');assert.equal(await video.getAttribute('autoplay'),null);assert.notEqual(await video.getAttribute('controls'),null);
    const wrapper=page.locator('#root > div');const before=await wrapper.boundingBox();
    await video.evaluate(node=>node.dispatchEvent(new Event('error')));
    await page.waitForFunction(()=>document.querySelector('video')?.getAttribute('src')?.includes('/api/conversations'));
    await video.evaluate(node=>node.dispatchEvent(new Event('error')));await page.getByText('Video unavailable').waitFor();
    assert.deepEqual(await wrapper.boundingBox(),before);
    await page.evaluate(a=>window.renderVideo({...a,name:'updated.mp4'}),attachment);assert.equal(await page.locator('video').count(),0);
    await page.evaluate(a=>window.renderVideo({...a,url:a.url+'?new-capability'}),attachment);await video.waitFor();
    assert.deepEqual(await wrapper.boundingBox(),before);
    await page.evaluate(a=>window.renderVideo({...a,video_trusted:undefined}),attachment);await page.getByText('Video unavailable').waitFor();
    assert.equal(renderRequests.some(type=>type==='fetch'||type==='xhr'),false);
  } finally {await browser?.close();await server.close();}
});
