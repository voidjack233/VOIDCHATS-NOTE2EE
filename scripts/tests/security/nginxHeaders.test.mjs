import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

for (const template of ['deploy/nginx/default.conf.template', 'VOID0000-www/docker/nginx/default.conf.template']) {
  test(`${template}: HTML and SPA fallback retain security headers`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'void-nginx-security-'));
    let nginx;
    try {
      const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
      const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
      await writeFile(join(temporary,'index.html'), '<!doctype html><title>Isolated header test</title>');
      const headers = await readFile('VOID0000-www/docker/nginx/security-headers.conf','utf8');
      const server = (await readFile(template,'utf8'))
        .replaceAll('${VOID_WEB_PORT}',`127.0.0.1:${port}`)
        .replaceAll('${VOID_WEB_SERVER_NAME}','localhost')
        .replaceAll('${VOID_DNS_RESOLVER}','127.0.0.1')
        .replaceAll('/usr/share/nginx/html',temporary)
        .replaceAll('include /etc/nginx/void-security-headers.conf;',headers);
      const config=join(temporary,'nginx.conf');
      await writeFile(config, `daemon off; master_process off; error_log stderr; pid ${temporary}/nginx.pid;
        events {} http { access_log off; ${server} }`);
      const check=spawnSync('nginx',['-t','-p',`${temporary}/`,'-c',config],{ encoding:'utf8' });
      assert.equal(check.status,0,check.stderr);
      nginx=spawn('nginx',['-p',`${temporary}/`,'-c',config],{ stdio:'ignore' });
      let ready=false;
      for (let i=0; i<50; i++) {
        try { await fetch(`http://127.0.0.1:${port}/health`); ready=true; break; } catch { await delay(20); }
      }
      assert.ok(ready,'isolated Nginx did not start');
      for (const path of ['/index.html','/chats/example']) {
        const res=await fetch(`http://127.0.0.1:${port}${path}`);
        assert.equal(res.status,200);
        assert.equal(res.headers.get('x-frame-options'),'DENY');
        assert.equal(res.headers.get('x-content-type-options'),'nosniff');
        assert.match(res.headers.get('content-security-policy'),/frame-ancestors 'none'/);
        assert.match(res.headers.get('cache-control'),/no-store/);
      }
    } finally {
      if (nginx && nginx.exitCode === null) { const exited=once(nginx,'exit'); nginx.kill('SIGQUIT'); await exited; }
      await rm(temporary,{ recursive:true, force:true });
    }
  });
}
