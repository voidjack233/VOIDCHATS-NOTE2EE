import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pool} from '../../../server/db.js';
import valkey from '../../../server/valkey.js';
import {createLoginSessionRecord, activateLoginSession} from '../../../server/auth/services/loginSessionService.js';
import {authenticateUser} from '../../../server/auth/middleware/authenticateUser.js';

export async function transaction(task) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await task(client); await client.query('COMMIT'); return result; }
  catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export function response() {
  return {statusCode:200, body:null, cookies:{}, status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;},cookie(name,value){this.cookies[name]=value;return this;},clearCookie(){return this;}};
}
export async function httpAuth(token, expectedAccount) {
  const res=response(); let accepted=false;
  await authenticateUser({cookies:{accessToken:token},headers:expectedAccount?{'x-void-account-id':expectedAccount}:{}},res,()=>accepted=true);
  return {accepted,status:res.statusCode,body:res.body};
}
export async function setupLifecycleFixture() {
  assert.equal(process.env.PGPORT,'15439'); assert.equal(process.env.VALKEY_PORT,'16389');
  const schema=`lifecycle_${randomUUID().replaceAll('-','')}`;
  pool.on('connect',client=>{void client.query(`SET search_path TO ${schema},public`);});
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`SET search_path TO ${schema},public`);
  await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,profile_id uuid NOT NULL,password_hash text DEFAULT 'original',is_verified boolean DEFAULT true,email text,username text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE refresh_tokens(id bigserial PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),device_id text NOT NULL,token_hash text,jti uuid,expires_at timestamptz DEFAULT now()+interval '30 days',created_at timestamptz DEFAULT now(),last_used_at timestamptz,ip_address text,user_agent text,device_name text,device_type text,is_revoked boolean DEFAULT false,revoked_at timestamptz,revoked_by uuid,previous_token_hash text,previous_jti uuid,previous_valid_until timestamptz,CONSTRAINT unique_user_device UNIQUE(user_id,device_id));
    CREATE TABLE password_resets(user_id uuid, token text,expires_at timestamptz DEFAULT now()+interval '1 day');
    CREATE TABLE user_2fa(user_id uuid,method text,is_enabled boolean)`);
  await pool.query(await readFile(new URL('../../../db/migrations/0014_immutable_session_identity.sql',import.meta.url),'utf8'));
  const subscriber=valkey.duplicate(); const commands=[];
  subscriber.on('message',(_channel,payload)=>commands.push(JSON.parse(payload)));
  await subscriber.subscribe('void:gateway');
  const users=[];
  return {
    schema,subscriber,commands,
    async user() {
      const id=randomUUID(),profile_id=randomUUID();users.push(id);
      await pool.query('INSERT INTO users(id,profile_id,email,username) VALUES($1,$2,$3,$4)',[id,profile_id,`${id}@example.test`,id]);
      return {id,profile_id};
    },
    async close() {
      for(const user of users){const keys=await valkey.keys(`session:${user}:*`);if(keys.length)await valkey.del(...keys);await valkey.del(`user_sessions:${user}`);}
      await subscriber.quit();await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();await valkey.quit();
    },
  };
}
export async function issue(user,deviceId='device',existingClient) {
  const client=existingClient??await pool.connect();
  try {
    await client.query('BEGIN');
    const session=await createLoginSessionRecord({queryable:client,user,req:{},res:{},userIp:'127.0.0.1',userAgent:'test',deviceContext:{deviceId,deviceInfo:{deviceName:'Test',deviceType:'desktop'},userIp:'127.0.0.1',userAgent:'test'}});
    await client.query('COMMIT');
    assert.ok(await activateLoginSession(session,client));
    return session;
  } catch(error){await client.query('ROLLBACK');throw error;}
  finally{if(!existingClient)client.release();}
}
