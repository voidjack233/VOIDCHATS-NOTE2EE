import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import cassandra from 'cassandra-driver';
import { reactionScylla } from './reactionAuditFixture.js';
const tasks = [], t = { after: fn => tasks.push(fn) };
try {
  const db = await reactionScylla(t);
  // This prototype deliberately uses its own table, not the production schema.
  const execute = db.execute.bind(db);
  db.execute = (sql, ...args) => execute(sql.replaceAll('reaction_state', 'reaction_probe'), ...args);
  await db.execute(`CREATE TABLE reaction_state(conversation_id uuid,message_id timeuuid,user_id uuid,emoji text,present boolean,counts map<text,int> static,revision bigint static,PRIMARY KEY ((conversation_id,message_id),user_id,emoji))`);
  const c = cassandra.types.Uuid.random(), m = cassandra.types.TimeUuid.now(), u = cassandra.types.Uuid.random();
  const options = { prepare: true, consistency: cassandra.types.consistencies.localQuorum, serialConsistency: cassandra.types.consistencies.localSerial };
  console.log('empty', (await db.execute('SELECT counts,revision,present FROM reaction_state WHERE conversation_id=? AND message_id=? AND user_id=? AND emoji=?', [c,m,u,'a'], options)).rows);
  console.log('batch', (await db.execute(`BEGIN BATCH UPDATE reaction_state SET counts=?, revision=? WHERE conversation_id=? AND message_id=? IF revision=null; INSERT INTO reaction_state(conversation_id,message_id,user_id,emoji,present) VALUES(?,?,?,?,true); APPLY BATCH`, [{a:1}, cassandra.types.Long.ONE, c,m,c,m,u,'a'], options)).rows);
  console.log('absent', (await db.execute('SELECT counts,revision,present FROM reaction_state WHERE conversation_id=? AND message_id=? AND user_id=? AND emoji=?', [c,m,u,'b'], options)).rows);
  console.log('summary', (await db.execute('SELECT DISTINCT conversation_id,message_id,counts,revision FROM reaction_state WHERE conversation_id=? AND message_id IN ?', [c,[m]], options)).rows);
  console.log('user', (await db.execute('SELECT message_id,emoji,present,revision FROM reaction_state WHERE conversation_id=? AND message_id IN ? AND user_id=?', [c,[m],u], options)).rows);
  for (const size of [10, 100]) for (const serialized of [false, true]) {
    const message = cassandra.types.TimeUuid.now(); let retries=0, done=0;
    let tail=Promise.resolve();
    const times=await Promise.all(Array.from({length:size},async()=>{
      const user=cassandra.types.Uuid.fromString(randomUUID()),start=performance.now();
      let release;
      if (serialized) { const previous=tail; tail=new Promise(resolve=>{release=resolve;}); await previous; }
      for(let attempt=0;attempt<100;attempt++) {
        const result=await db.execute('SELECT DISTINCT conversation_id,message_id,counts,revision FROM reaction_state WHERE conversation_id=? AND message_id=?',[c,message],options);
        const row=result.rows[0],count=Number(row?.counts?.a||0),rev=row?.revision;
        const applied=await db.execute(`BEGIN BATCH UPDATE reaction_state SET counts=?,revision=? WHERE conversation_id=? AND message_id=? IF revision=?; INSERT INTO reaction_state(conversation_id,message_id,user_id,emoji,present) VALUES(?,?,?,?,true); APPLY BATCH`,[{a:count+1},cassandra.types.Long.fromNumber(count+1),c,message,rev||null,c,message,user,'a'],options);
        if(applied.wasApplied()) { done++; release?.(); return performance.now()-start; }
        retries++; await new Promise(resolve=>setTimeout(resolve,Math.random()*20));
      } throw new Error('exhausted');
    }));
    times.sort((a,b)=>a-b); console.log(JSON.stringify({size,serialized,done,retries,p50:times[Math.floor(size/2)],p95:times[Math.floor(size*.95)]}));
  }
} finally { for (const fn of tasks.reverse()) await fn(); }
