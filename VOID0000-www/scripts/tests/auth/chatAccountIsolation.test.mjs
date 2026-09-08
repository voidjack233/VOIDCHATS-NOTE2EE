import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('real IndexedDB isolates shared-conversation drafts and retires outgoing-account writers', async () => {
  const server = await createServer({
    configFile: false, root: process.cwd(), appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  server.middlewares.use((req, res, next) => {
    if (req.url !== '/') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Isolated cache test</title>');
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const external = [];
    page.on('request', (req) => { if (!req.url().startsWith(server.resolvedUrls.local[0])) external.push(req.url()); });
    await page.goto(server.resolvedUrls.local[0]);
    const result = await page.evaluate(async () => {
      const account = await import('/src/Services/Chat/chatStorageAccount.ts');
      const queue = await import('/src/Services/Chat/queuedSendStore.ts');
      const messages = await import('/src/Services/Chat/chatStore.ts');
      const { MessageSync } = await import('/src/Services/Chat/chatSyncCore.ts');
      const record = { conversation_id: 'shared', local_client_id: 'draft-a', sender_id: 'a', text: 'private draft A', uploaded_urls: [], reply_to_id: null, created_at: new Date().toISOString() };
      account.setChatStorageAccount('a');
      const oldQueue = queue.queuedSendStore;
      const oldMessages = messages.messageStore;
      await oldQueue.put(record);
      await oldMessages.putMessage({ conversation_id: 'shared', message_id: 'm1', sender_id: 'a', content: 'cached A', created_at: record.created_at });
      const aCount = (await oldQueue.getByConversation('shared', 'a')).length;
      const deniedRead = (await oldQueue.getByConversation('shared', 'b')).length;
      let finishFetch;
      const responseGate = new Promise((resolve) => { finishFetch = resolve; });
      const oldSync = new MessageSync(oldMessages, async () => {
        await responseGate;
        return { messages: [{ conversation_id: 'private-a', message_id: 'late-a', sender_id: 'a', content: 'late private A' }], has_more: false };
      });
      const pending = await oldSync.loadConversation('private-a');
      account.setChatStorageAccount(null);
      account.setChatStorageAccount('b');
      finishFetch();
      const oldSyncResult = await pending.syncPromise;
      const bDrafts = await queue.queuedSendStore.getByConversation('shared', 'b');
      const bMessages = await messages.messageStore.getMessageCount('shared');
      const privateLeak = await messages.messageStore.getMessageCount('private-a');
      let rejected = 0;
      for (const task of [() => oldQueue.put(record), () => oldMessages.putMessage({ message_id: 'late' }), () => queue.queuedSendStore.put(record)]) {
        try { await task(); } catch { rejected++; }
      }
      await queue.queuedSendStore.put({ ...record, sender_id: 'b', text: 'draft B' });
      const bOwnDraft = (await queue.queuedSendStore.getAll('b'))[0]?.text;
      const dbNames = (await indexedDB.databases()).map((db) => db.name);
      account.setChatStorageAccount(null);
      return { aCount, deniedRead, bDrafts, bMessages, privateLeak, oldSyncResult, rejected, bOwnDraft, dbNames };
    });
    assert.equal(result.aCount,1);
    assert.equal(result.deniedRead,0);
    assert.deepEqual(result.bDrafts,[]);
    assert.equal(result.bMessages,0);
    assert.equal(result.privateLeak,0);
    assert.equal(result.oldSyncResult.didSync,false);
    assert.equal(result.rejected,3);
    assert.equal(result.bOwnDraft,'draft B');
    assert.ok(!result.dbNames.includes('void_queued_sends:a'));
    assert.ok(!result.dbNames.includes('void_messages:a'));
    assert.deepEqual(external,[]);
  } finally { await browser?.close(); await server.close(); }
});
