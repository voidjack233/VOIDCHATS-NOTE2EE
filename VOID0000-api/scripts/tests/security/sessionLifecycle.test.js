import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {pool} from '../../../server/db.js';
import valkey from '../../../server/valkey.js';
import {sessionStore} from '../../../server/auth/services/sessionService.js';
import {revokeCredentialRecords} from '../../../server/auth/services/credentialInvalidation.js';
import {createLoginSessionRecord,activateLoginSession} from '../../../server/auth/services/loginSessionService.js';
import {verifyAccessToken,verifyRefreshToken,signAccessToken} from '../../../server/auth/services/tokenService.js';
import refresh from '../../../server/auth/routes/refresh.js';
import logout from '../../../server/auth/routes/logout.js';
import csrf from '../../../server/routes/csrf/index.js';
import changePassword from '../../../server/auth/routes/change-password.js';
import resetPassword from '../../../server/auth/routes/reset-password.js';
import {hashToken} from '../../../server/auth/services/tokenService.js';
import {hashPassword} from '../../../server/auth/services/credentialService.js';
import {IPSecurity} from '../../../server/utils/securityUtils.js';
import {setupLifecycleFixture,transaction,issue,httpAuth,response} from './sessionLifecycleFixture.js';

let fixture;
before(async()=>{fixture=await setupLifecycleFixture();});
after(async()=>{await fixture?.close();});
const handler=router=>router.stack.find(layer=>layer.route).route.stack.at(-1).handle;
const request=(token,userId)=>({cookies:{refreshToken:token},headers:userId?{'x-void-account-id':userId}:{},get:()=>'',ip:'127.0.0.1',socket:{remoteAddress:'127.0.0.1'},path:'/api/auth/refresh'});

test('session activation reuses every held pool slot and completes above capacity', {timeout:10000}, async()=>{
  const size=pool.options.max;
  const users=await Promise.all(Array.from({length:size},()=>fixture.user()));
  const clients=await Promise.all(users.map(()=>pool.connect()));
  try {
    const pending=await Promise.all(clients.map(async(client,index)=>{
      await client.query('BEGIN');
      const record=await createLoginSessionRecord({queryable:client,user:users[index],req:{},res:{},userIp:'127.0.0.1',userAgent:'test',deviceContext:{deviceId:'pool',deviceInfo:{deviceName:'Pool',deviceType:'desktop'},userIp:'127.0.0.1',userAgent:'test'}});
      await client.query('COMMIT');return record;
    }));
    const activated=await Promise.all(pending.map((record,index)=>activateLoginSession(record,clients[index])));
    assert.ok(activated.every(Boolean));assert.equal(pool.waitingCount,0);
  }finally{clients.forEach(client=>client.release());}
  const more=await Promise.all(Array.from({length:size*2},(_,index)=>issue(users[index%size],`burst-${index}`)));
  assert.equal(more.length,size*2);assert.equal(pool.waitingCount,0);
});

test('refresh preserves immutable sid including simultaneous predecessor recovery',async()=>{
  const user=await fixture.user(),session=await issue(user);
  const responses=await Promise.all([1,2,3].map(async()=>{const res=response();await handler(refresh)(request(session.refreshToken),res);return res;}));
  assert.ok(responses.every(res=>res.statusCode===200));
  assert.equal(new Set(responses.map(res=>res.cookies.refreshToken)).size,1);
  for(const res of responses){assert.equal(verifyAccessToken(res.cookies.accessToken).sid,session.sessionId);assert.equal(verifyRefreshToken(res.cookies.refreshToken).sid,session.sessionId);}
});

test('replacement rejects old access, refresh, and logout without adopting or revoking new sid',async(t)=>{
  t.mock.method(IPSecurity,'logIPActivity',async()=>{});
  const user=await fixture.user(),old=await issue(user),replacement=await issue(user);
  assert.notEqual(old.sessionId,replacement.sessionId);
  assert.equal((await httpAuth(old.accessToken)).accepted,false);
  assert.equal((await httpAuth(replacement.accessToken)).accepted,true);
  const res=response();await handler(refresh)(request(old.refreshToken),res);assert.equal(res.statusCode,403);
  const loggedOut=response();await handler(logout)(request(old.refreshToken),loggedOut);
  assert.equal(loggedOut.statusCode,200);assert.equal((await httpAuth(replacement.accessToken)).accepted,true);
  await valkey.del(`session:${user.id}:device`);
  assert.equal((await httpAuth(old.accessToken)).accepted,false);
  assert.equal((await httpAuth(replacement.accessToken)).accepted,true);
});

for(const mode of ['expired','incomplete'])test(`revoke all ignores ${mode} session indexes`,async()=>{
  const user=await fixture.user(),a=await issue(user,'a'),b=await issue(user,'b');
  if(mode==='expired'){await valkey.pexpire(`user_sessions:${user.id}`,1);await delay(10);}
  else await valkey.srem(`user_sessions:${user.id}`,'b');
  await transaction(client=>revokeCredentialRecords(client,user.id));
  for(const session of [a,b]){assert.equal((await httpAuth(session.accessToken)).accepted,false);assert.equal(await valkey.exists(`session:${user.id}:${session.deviceId}`),0);}
  await transaction(client=>revokeCredentialRecords(client,user.id));
  assert.equal((await httpAuth(a.accessToken)).accepted,false);
});

test('touch repairs the display index but cannot recreate a revoked session',async()=>{
  const user=await fixture.user(),a=await issue(user);
  await valkey.del(`user_sessions:${user.id}`);
  assert.ok(await sessionStore.touch(user.id,a.deviceId,a.sessionId));
  assert.deepEqual(await valkey.smembers(`user_sessions:${user.id}`),['device']);
  await Promise.all([sessionStore.touch(user.id,a.deviceId,a.sessionId),transaction(client=>sessionStore.revoke(user.id,a.deviceId,client,a.sessionId))]);
  assert.equal(await sessionStore.touch(user.id,a.deviceId,a.sessionId),false);
  assert.equal(await sessionStore.create(user.id,a.deviceId,a.sessionId),null);
});

test('SQL/cache recovery waits behind revocation and observes its commit',async()=>{
  const user=await fixture.user(),a=await issue(user);const client=await pool.connect();
  try{
    await client.query('BEGIN');await sessionStore.revokeAll(user.id,client);
    let settled=false;const recovery=sessionStore.create(user.id,a.deviceId,a.sessionId).then(result=>{settled=true;return result;});
    await delay(30);assert.equal(settled,false);await client.query('COMMIT');assert.equal(await recovery,null);
  }finally{await client.query('ROLLBACK');client.release();}
});

test('admin/shared invalidation publishes without API publisher initialization',async()=>{
  const user=await fixture.user(),session=await issue(user);
  await pool.query('INSERT INTO password_resets(user_id,token) VALUES($1,$2)',[user.id,randomUUID()]);
  await transaction(async client=>{await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',['changed',user.id]);await revokeCredentialRecords(client,user.id);});
  await delay(20);
  assert.ok(fixture.commands.some(command=>command.command==='disconnectSession'&&command.data.sessionId===session.sessionId));
  assert.equal((await pool.query('SELECT * FROM password_resets WHERE user_id=$1',[user.id])).rowCount,0);
  assert.equal((await httpAuth(session.accessToken)).accepted,false);
});

test('normal password replacement revokes all prior generations but permits the replacement',async()=>{
  const user=await fixture.user(),a=await issue(user,'a'),b=await issue(user,'b');
  await transaction(client=>revokeCredentialRecords(client,user.id));
  const replacement=await issue(user,'a');
  for(const old of [a,b])assert.equal((await httpAuth(old.accessToken)).accepted,false);
  assert.equal((await httpAuth(replacement.accessToken)).accepted,true);
});

test('missing gateway subscriber rolls back credential changes instead of claiming success',async()=>{
  const user=await fixture.user();await issue(user);
  await fixture.subscriber.unsubscribe('void:gateway');
  try {
    await assert.rejects(transaction(async client=>{await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',['must-rollback',user.id]);await revokeCredentialRecords(client,user.id);}),/no gateway subscriber/);
    assert.equal((await pool.query('SELECT password_hash FROM users WHERE id=$1',[user.id])).rows[0].password_hash,'original');
    assert.equal((await pool.query('SELECT is_revoked FROM refresh_tokens WHERE user_id=$1',[user.id])).rows[0].is_revoked,false);
  }finally{await fixture.subscriber.subscribe('void:gateway');}
});

test('Valkey invalidation failure rolls back and must propagate',async(t)=>{
  const user=await fixture.user(),session=await issue(user);
  t.mock.method(valkey,'eval',async()=>{throw Error('isolated invalidation outage');});
  await assert.rejects(transaction(client=>revokeCredentialRecords(client,user.id)),/invalidation outage/);
  t.mock.restoreAll();assert.equal((await httpAuth(session.accessToken)).accepted,true);
});

test('foreign expected account cannot mutate, refresh, or acquire CSRF with another account cookie',async()=>{
  const a=await fixture.user(),b=await fixture.user(),session=await issue(b);
  assert.equal((await httpAuth(session.accessToken,a.id)).status,409);
  const res=response();await handler(refresh)(request(session.refreshToken,a.id),res);assert.equal(res.statusCode,409);assert.deepEqual(res.cookies,{});
  const csrfRes=response();handler(csrf)({...request(session.refreshToken,a.id),cookies:{accessToken:session.accessToken,refreshToken:session.refreshToken}},csrfRes);
  assert.equal(csrfRes.statusCode,409);assert.deepEqual(csrfRes.cookies,{});
});

test('legacy or wrong identity cannot revive a cache even when timestamps coincide',async()=>{
  const user=await fixture.user(),session=await issue(user);
  const wrong=signAccessToken({id:user.id,profile_id:user.profile_id,device_id:session.deviceId,sid:randomUUID()});
  const legacy=signAccessToken({id:user.id,profile_id:user.profile_id,device_id:session.deviceId});
  assert.equal((await httpAuth(wrong)).accepted,false);assert.equal((await httpAuth(legacy)).accepted,false);
});

test('a delayed cache CREATE cannot resurrect an invalidated sid',async(t)=>{
  const user=await fixture.user();let create;
  const evalCommand=valkey.eval.bind(valkey);
  t.mock.method(valkey,'eval',async(...args)=>{if(args[0].includes("redis.call('SET', KEYS[1], ARGV[1]"))create=args;return evalCommand(...args);});
  const session=await issue(user);assert.ok(create);t.mock.restoreAll();
  await transaction(client=>revokeCredentialRecords(client,user.id));
  assert.equal(await valkey.eval(...create),null);
  assert.equal(await valkey.exists(`session:${user.id}:device`),0);
  assert.equal((await httpAuth(session.accessToken)).accepted,false);
});

test('cache timeout is bounded and never commits credential replacement', {timeout:7000},async(t)=>{
  const user=await fixture.user();await issue(user);
  t.mock.method(valkey,'eval',()=>new Promise(()=>{}));
  await assert.rejects(transaction(async client=>{await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',['timed-out',user.id]);await revokeCredentialRecords(client,user.id);}),/cache unavailable/);
  t.mock.restoreAll();assert.equal((await pool.query('SELECT password_hash FROM users WHERE id=$1',[user.id])).rows[0].password_hash,'original');
  assert.equal(pool.waitingCount,0);
});

test('a partially invalidated rolled-back sid stays fenced, including refresh',async()=>{
  const user=await fixture.user(),session=await issue(user);
  await fixture.subscriber.unsubscribe('void:gateway');
  try{await assert.rejects(transaction(client=>revokeCredentialRecords(client,user.id)),/no gateway subscriber/);}
  finally{await fixture.subscriber.subscribe('void:gateway');}
  const res=response();await handler(refresh)(request(session.refreshToken),res);
  assert.equal(res.statusCode,403);assert.equal((await httpAuth(session.accessToken)).accepted,false);
  const fresh=await issue(user);assert.equal((await httpAuth(fresh.accessToken)).accepted,true);
});

test('actual password-change completion invalidates old devices and issues a usable replacement',async(t)=>{
  t.mock.method(IPSecurity,'logIPActivity',async()=>{});
  const user=await fixture.user(),device=randomUUID();const currentPassword='Original-secure-test-password-12!';
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2',[await hashPassword(currentPassword),user.id]);
  const old=await issue(user,device),other=await issue(user,'other');const res=response();
  await handler(changePassword)({...request(old.refreshToken),user:verifyAccessToken(old.accessToken),cookies:{deviceId:device},body:{currentPassword,newPassword:'Changed-secure-test-password-34!'}},res);
  assert.equal(res.statusCode,200);assert.ok(res.cookies.accessToken);
  assert.equal((await httpAuth(old.accessToken)).accepted,false);assert.equal((await httpAuth(other.accessToken)).accepted,false);
  assert.equal((await httpAuth(res.cookies.accessToken)).accepted,true);
});

test('refresh racing account-wide revocation cannot retain a usable token or deadlock', {timeout:10000}, async()=>{
  const user=await fixture.user(),session=await issue(user);
  await issue(user,'expired');
  await pool.query("UPDATE refresh_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND device_id='expired'",[user.id]);
  const replies=Array.from({length:pool.options.max+2},()=>response());
  await Promise.all([
    ...replies.map(res=>handler(refresh)(request(session.refreshToken),res)),
    transaction(client=>revokeCredentialRecords(client,user.id)),
  ]);
  for(const res of replies){
    assert.ok([200,403].includes(res.statusCode),JSON.stringify(res.body));
    if(res.cookies.accessToken)assert.equal((await httpAuth(res.cookies.accessToken)).accepted,false);
  }
  assert.equal((await httpAuth(session.accessToken)).accepted,false);
  const final=response();await handler(refresh)(request(session.refreshToken),final);
  assert.equal(final.statusCode,403);assert.equal(pool.waitingCount,0);
});

test('actual password reset revokes all devices and cannot consume a reset token twice',async(t)=>{
  t.mock.method(IPSecurity,'logIPActivity',async()=>{});
  const user=await fixture.user(),a=await issue(user,'a'),b=await issue(user,'b'),token=randomUUID();
  await pool.query('INSERT INTO password_resets(user_id,token) VALUES($1,$2)',[user.id,hashToken(token)]);
  const req={...request(a.refreshToken),body:{token,newPassword:'Reset-secure-test-password-567!'}};
  const results=await Promise.all([1,2].map(async()=>{const res=response();await handler(resetPassword)(req,res);return res;}));
  assert.deepEqual(results.map(res=>res.statusCode).sort(),[200,400]);
  for(const old of [a,b])assert.equal((await httpAuth(old.accessToken)).accepted,false);
});
