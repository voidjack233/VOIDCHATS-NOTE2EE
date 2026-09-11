import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import test,{before,after} from 'node:test';
import {setupLifecycleFixture,issue,httpAuth} from './sessionLifecycleFixture.js';
import {pool} from '../../../server/db.js';

let fixture,child;
const origin='http://127.0.0.1:14979';
const password='Isolated-admin-only-Secret-893!';
before(async()=>{
  fixture=await setupLifecycleFixture();
  child=spawn(process.execPath,['server.js'],{cwd:new URL('../../../../VOIDADMIN/',import.meta.url),env:{...process.env,PGOPTIONS:`-c search_path=${fixture.schema},public`,ADMIN_PANEL_HOST:'127.0.0.1',ADMIN_PANEL_PORT:'14979',ADMIN_PANEL_USERNAME:'audit-operator',ADMIN_PANEL_PASSWORD:password},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  for(let i=0;i<100;i++){if(output.includes('VOIDADMIN running'))return;if(child.exitCode!==null)throw Error(output);await delay(50);}
  throw Error('Isolated admin did not start');
});
after(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}await fixture?.close();});
const update=(userId,newPassword)=>fetch(`${origin}/api/users/${userId}`,{method:'PATCH',headers:{Authorization:`Basic ${Buffer.from(`audit-operator:${password}`).toString('base64')}`,'Content-Type':'application/json'},body:JSON.stringify({password:newPassword})});

test('real admin process revokes sessions and publishes without account-process initialization',async()=>{
  const user=await fixture.user(),session=await issue(user);
  const res=await update(user.id,'New-isolated-admin-password-123!');assert.equal(res.status,200,await res.text());await delay(30);
  assert.ok(fixture.commands.some(command=>command.command==='disconnectSession'&&command.data.sessionId===session.sessionId));
  assert.equal((await httpAuth(session.accessToken)).accepted,false);
});

test('real admin returns failure and rolls back password when required publication is unavailable',async()=>{
  const user=await fixture.user();await issue(user);
  await fixture.subscriber.unsubscribe('void:gateway');
  try{
    const res=await update(user.id,'Must-not-be-committed-password-456!');assert.equal(res.status,500);
    assert.equal((await pool.query('SELECT password_hash FROM users WHERE id=$1',[user.id])).rows[0].password_hash,'original');
  }finally{await fixture.subscriber.subscribe('void:gateway');}
});
