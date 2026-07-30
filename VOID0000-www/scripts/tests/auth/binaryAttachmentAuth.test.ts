import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearCSRFToken,
  fetchWithAuth,
  setAuthLogoutInProgress,
} from '../../../src/Services/Auth/client/authClient';
import { uploadAttachments } from '../../../src/Services/Chat/messageService';
import { parseAttachment } from '../../../src/Services/Chat/messageAttachments';

const nativeFetch = globalThis.fetch;

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    addEventListener() {},
    clearTimeout,
    dispatchEvent() {
      return true;
    },
    location: { origin: 'http://localhost:5173' },
    removeEventListener() {},
    setTimeout,
  },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true },
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resetAuthClientState() {
  clearCSRFToken();
  setAuthLogoutInProgress(false);
}

test.after(() => {
  globalThis.fetch = nativeFetch;
});

test('attachment upload sends the original File as authenticated raw binary', async () => {
  resetAuthClientState();
  const originalBytes = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x01]);
  const file = new File([originalBytes], 'sample file.bin', {
    type: 'application/octet-stream',
  });
  let uploadRequest: RequestInit | undefined;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/csrf/csrf-token')) {
      return jsonResponse({ success: true, csrfToken: 'csrf-one' });
    }
    if (url.endsWith('/api/conversations/conversation-1/attachments')) {
      uploadRequest = init;
      return jsonResponse({
        success: true,
        urls: [
          '/api/conversations/conversation-1/attachments/11111111-1111-4111-8111-111111111111',
        ],
        attachments: [{
          mime: 'application/octet-stream',
          size: originalBytes.length,
        }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const [serialized] = await uploadAttachments('conversation-1', [file]);
  assert.strictEqual(uploadRequest?.body, file);
  assert.equal(uploadRequest?.credentials, 'include');
  assert.deepEqual(
    new Uint8Array(await (uploadRequest!.body as File).arrayBuffer()),
    originalBytes,
  );

  const headers = new Headers(uploadRequest?.headers);
  assert.equal(headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(headers.get('X-CSRF-Token'), 'csrf-one');
  assert.equal(headers.get('X-Attachment-Mime'), 'application/octet-stream');
  assert.equal(
    decodeURIComponent(headers.get('X-Attachment-Filename') || ''),
    'sample file.bin',
  );

  const descriptor = parseAttachment(serialized);
  assert.equal(
    descriptor.url,
    '/api/conversations/conversation-1/attachments/11111111-1111-4111-8111-111111111111',
  );
  assert.equal(descriptor.name, 'sample file.bin');
  assert.equal(descriptor.size, originalBytes.length);
});

test('multiple files use separate raw requests and preserve result order', async () => {
  resetAuthClientState();
  const files = [
    new File(['first'], 'first.bin'),
    new File(['second'], 'second.bin'),
  ];
  const uploadBodies: BodyInit[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/csrf/csrf-token')) {
      return jsonResponse({ success: true, csrfToken: 'csrf-many' });
    }
    if (url.endsWith('/attachments')) {
      uploadBodies.push(init!.body!);
      const index = uploadBodies.length;
      return jsonResponse({
        success: true,
        urls: [
          `/api/conversations/conversation-1/attachments/11111111-1111-4111-8111-11111111111${index}`,
        ],
        attachments: [{
          mime: 'application/octet-stream',
          size: files[index - 1]!.size,
        }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const results = await uploadAttachments('conversation-1', files);
  assert.equal(uploadBodies.length, 2);
  assert.strictEqual(uploadBodies[0], files[0]);
  assert.strictEqual(uploadBodies[1], files[1]);
  assert.match(results[0]!, /11111111-1111-4111-8111-111111111111/);
  assert.match(results[1]!, /11111111-1111-4111-8111-111111111112/);
});

test('ordinary JSON mutations retain the application/json content type', async () => {
  resetAuthClientState();
  let mutationRequest: RequestInit | undefined;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/csrf/csrf-token')) {
      return jsonResponse({ success: true, csrfToken: 'csrf-json' });
    }
    mutationRequest = init;
    return jsonResponse({ success: true });
  };

  await fetchWithAuth('/api/json-mutation', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
  });

  const headers = new Headers(mutationRequest?.headers);
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get('X-CSRF-Token'), 'csrf-json');
});

test('a 401 refresh retries the same reusable File with binary headers intact', async () => {
  resetAuthClientState();
  const file = new File(['retry-bytes'], 'retry.bin', {
    type: 'application/octet-stream',
  });
  let csrfRequests = 0;
  let refreshRequests = 0;
  const uploadRequests: Array<{
    body: BodyInit | null | undefined;
    contentType: string | null;
    csrfToken: string | null;
  }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/csrf/csrf-token')) {
      csrfRequests += 1;
      return jsonResponse({
        success: true,
        csrfToken: `csrf-${csrfRequests}`,
      });
    }
    if (url.endsWith('/api/auth/refresh')) {
      refreshRequests += 1;
      return jsonResponse({ success: true });
    }
    if (url.endsWith('/api/conversations/conversation-1/attachments')) {
      const headers = new Headers(init?.headers);
      uploadRequests.push({
        body: init?.body,
        contentType: headers.get('Content-Type'),
        csrfToken: headers.get('X-CSRF-Token'),
      });
      return uploadRequests.length === 1
        ? jsonResponse({ error: 'expired access token' }, 401)
        : jsonResponse({ success: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const response = await fetchWithAuth(
    '/api/conversations/conversation-1/attachments',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Attachment-Filename': encodeURIComponent(file.name),
      },
      body: file,
    },
  );

  assert.equal(response.ok, true);
  assert.equal(refreshRequests, 1);
  assert.equal(csrfRequests, 2);
  assert.equal(uploadRequests.length, 2);
  assert.strictEqual(uploadRequests[0].body, file);
  assert.strictEqual(uploadRequests[1].body, file);
  assert.equal(uploadRequests[0].contentType, 'application/octet-stream');
  assert.equal(uploadRequests[1].contentType, 'application/octet-stream');
  assert.equal(uploadRequests[0].csrfToken, 'csrf-1');
  assert.equal(uploadRequests[1].csrfToken, 'csrf-2');
});
