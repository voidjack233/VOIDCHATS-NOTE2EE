import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';

for(const scenario of ['csrf','refresh','csrf-retry','a-b-a','queued','queue-stop']) {
  test(`account operation is permanently cancelled: ${scenario}`, {timeout:15000}, async()=>{
    let release,arrived;
    const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>arrived=resolve);
    let csrfCount=0,mutationCount=0,switched=false;
    const requests=[];
    const server=await createServer({configFile:false,root:process.cwd(),appType:'custom',optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:0,watch:null}});
    server.middlewares.use(async(req,res,next)=>{
      if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<title>Account boundary test</title>');}
      if(!req.url.startsWith('/api/'))return next();
      requests.push({url:req.url,afterSwitch:switched,cookie:req.headers.cookie,expected:req.headers['x-void-account-id']});
      res.setHeader('Content-Type','application/json');
      if(req.url==='/api/csrf/csrf-token'){
        csrfCount++;
        if(['csrf','a-b-a','queued','queue-stop'].includes(scenario)||(scenario==='csrf-retry'&&csrfCount===2)){arrived();await gate;}
        return res.end(JSON.stringify({success:true,csrfToken:'test-csrf'}));
      }
      if(req.url==='/api/auth/refresh'){arrived();await gate;return res.end(JSON.stringify({success:true}));}
      mutationCount++;
      if(scenario==='refresh')res.statusCode=401;
      if(scenario==='csrf-retry'&&mutationCount===1)res.statusCode=403;
      return res.end(JSON.stringify({success:res.statusCode===200,message:{message_id:'server-message'},error:res.statusCode===403?'CSRF invalid':undefined}));
    });
    let browser;
    try {
      await server.listen();const origin=server.resolvedUrls.local[0];
      browser=await chromium.launch({headless:true});const context=await browser.newContext();
      const external=[];await context.route('**/*',route=>{if(route.request().url().startsWith(origin))return route.continue();external.push(route.request().url());return route.abort();});
      await context.addCookies([{name:'accessToken',value:'account-a',url:origin,httpOnly:true}]);const page=await context.newPage();await page.goto(origin);
      await page.evaluate(async scenario=>{
        const account=await import('/src/Services/Chat/chatStorageAccount.ts');account.setChatStorageAccount('a');
        if(scenario==='queued'||scenario==='queue-stop'){
          const queue=await import('/src/Services/Chat/queuedSendStore.ts');
          await queue.queuedSendStore.put({conversation_id:'shared',local_client_id:'draft-a',sender_id:'a',text:'PRIVATE DRAFT A',uploaded_urls:[],reply_to_id:null,created_at:new Date().toISOString()});
          (await import('/src/Services/Chat/queuedSendRecovery.ts')).queuedSendRecovery.start('a');
        } else {
          const auth=await import('/src/Services/Auth/client/authClient.ts');
          window.auditResult=auth.fetchWithAuth('/api/mutation',{method:'POST',body:JSON.stringify({text:'PRIVATE DRAFT A'})}).then(()=>({sent:true}),error=>({sent:false,code:error.code,name:error.name}));
        }
      },scenario);
      await waiting;
      await page.evaluate(async scenario=>{
        (await import('/src/Services/Chat/queuedSendRecovery.ts')).queuedSendRecovery.stop();
        if(scenario==='queue-stop')return;
        const account=await import('/src/Services/Chat/chatStorageAccount.ts');account.setChatStorageAccount(null);account.setChatStorageAccount('b');if(scenario==='a-b-a')account.setChatStorageAccount('a');
      },scenario);
      switched=true;
      await context.addCookies([{name:'accessToken',value:scenario==='a-b-a'?'account-a':'account-b',url:origin,httpOnly:true}]);
      release();
      if(!['queued','queue-stop'].includes(scenario)){
        const result=await page.evaluate(()=>window.auditResult);assert.equal(result.sent,false);assert.ok(result.code==='AUTH_ACCOUNT_CHANGED'||result.name==='AbortError');
      }
      await delay(150);
      assert.deepEqual(requests.filter(entry=>entry.afterSwitch),[]);
      assert.equal(mutationCount,['refresh','csrf-retry'].includes(scenario)?1:0);
      assert.ok(requests.every(entry=>entry.expected==='a'));
      assert.deepEqual(external,[]);
    } finally {release();await browser?.close();await server.close();}
  });
}

test('same-account concurrent callers share CSRF and refresh and retry successfully',{timeout:15000},async()=>{
  let release,arrived;const gate=new Promise(r=>release=r),waiting=new Promise(r=>arrived=r);
  let csrfCount=0,refreshCount=0,mutations=0;
  const server=await createServer({configFile:false,root:process.cwd(),appType:'custom',optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:0,watch:null}});
  server.middlewares.use(async(req,res,next)=>{
    if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<title>Same-account test</title>');}
    if(!req.url.startsWith('/api/'))return next();res.setHeader('Content-Type','application/json');
    if(req.url==='/api/csrf/csrf-token'){csrfCount++;return res.end(JSON.stringify({success:true,csrfToken:'test'}));}
    if(req.url==='/api/auth/refresh'){refreshCount++;await gate;return res.end(JSON.stringify({success:true}));}
    mutations++;res.statusCode=mutations<=8?401:200;if(mutations===8)arrived();res.end(JSON.stringify({success:res.statusCode===200}));
  });
  let browser;
  try{await server.listen();const origin=server.resolvedUrls.local[0];browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());await page.goto(origin);
    await page.evaluate(async()=>{(await import('/src/Services/Chat/chatStorageAccount.ts')).setChatStorageAccount('same');const auth=await import('/src/Services/Auth/client/authClient.ts');window.auditResult=Promise.all(Array.from({length:8},()=>auth.fetchWithAuth('/api/mutation',{method:'POST'}).then(r=>r.status)));});
    await waiting;await delay(50);release();assert.deepEqual(await page.evaluate(()=>window.auditResult),Array(8).fill(200));assert.equal(refreshCount,1);assert.equal(csrfCount,2);assert.equal(mutations,16);
  }finally{release();await browser?.close();await server.close();}
});
