import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {collectDeploymentProgress} from './deployment-progress.js';
import {publishIssueSpec} from './issue-specification.js';
import {issueClient,publisherIdentity} from './github-app.js';
import type {Topic} from './intake-journal.js';

export const fingerprint=(input:string)=>createHash('sha256').update(input).digest('hex');
function open(state:string) {
  const db=new DatabaseSync(join(state,'work-progress.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS events(issue INTEGER,key TEXT,body TEXT,status TEXT DEFAULT 'pending',
    receipt INTEGER,retryAt INTEGER DEFAULT 0,PRIMARY KEY(issue,key))`);
  if(!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name='markdown'").get())db.exec('ALTER TABLE events ADD COLUMN markdown TEXT; ALTER TABLE events ADD COLUMN purpose TEXT;');
  return db;
}
export function recordProgress(state:string,issue:number,identity:string,summary:string,report?:{purpose:'review'|'tests'|'consultation';markdown:string}) {
  const db=open(state);
  try {
    const key=fingerprint(identity);
    const body=summary+'\n\n<!-- jam-bot:progress:'+key+' -->';
    db.prepare('INSERT OR IGNORE INTO events(issue,key,body,markdown,purpose) VALUES(?,?,?,?,?)').run(issue,key,body,report?.markdown??null,report?.purpose??null);
  } finally {db.close();}
}

type Api=Awaited<ReturnType<typeof issueClient>>;
type Comment={id:number;user:{id:number};body:string;issue_url:string};
export async function publishProgress(state:string,topic:Topic,credentials=async():Promise<[Api,number]>=>Promise.all([
  issueClient(topic.repository,topic.installation),publisherIdentity(topic.repository,topic.installation)])){
  const db=open(state);
  try{
    const event=db.prepare("SELECT * FROM events WHERE receipt IS NULL AND retryAt<=unixepoch() ORDER BY rowid LIMIT 1").get();
    if(!event)return false;
    const issue=Number(event.issue),key=String(event.key),body=String(event.body);
    const path='/issues/'+issue+'/comments';
    const issueUrl='https://api.github.com/repos/'+topic.repository+'/issues/'+issue;
    try{
      const [api,bot]=await credentials();
      if((await api('')).id!==topic.repoId)throw Error('Work card repository identity changed');
      if(typeof event.markdown==='string'){
        await publishIssueSpec(state,topic.repository,topic.repoId,issue,event.markdown,bot,api,async()=>{},new AbortController().signal,event.purpose as 'review'|'tests'|'consultation');
      }
      let received:Comment|undefined;
      for(let page=1;;page++){
        const rows:Comment[]=await api(path+'?per_page=100&page='+page);
        const matching=rows.filter(c=>c.user?.id===bot && c.body===body && c.issue_url===issueUrl);
        if(matching.length+(received?1:0)>1)throw Error('Duplicate work progress evidence');
        received??=matching[0];
        if(rows.length<100)break;
      }
      if(!received && db.prepare("UPDATE events SET status='sending' WHERE issue=? AND key=? AND status='pending' AND receipt IS NULL").run(issue,key).changes){
        try{received=await api(path,'POST',{body});}
        catch(error){
          const status=(error as {status?:number}).status;
          if(status && [400,401,403,404,422,429].includes(status))
            db.prepare("UPDATE events SET status='pending' WHERE issue=? AND key=?").run(issue,key);
          throw error;
        }
      }
      if(!received || received.body!==body || received.user?.id!==bot || received.issue_url!==issueUrl || !Number.isSafeInteger(received.id))
        throw Error('Unconfirmed timeline entry');
      db.prepare("UPDATE events SET receipt=?,status='sent' WHERE issue=? AND key=?").run(received.id,issue,key);
    } catch {
      db.prepare('UPDATE events SET retryAt=unixepoch()+60 WHERE issue=? AND key=?').run(issue,key);
    }
    return true;
  }finally{db.close();}
}
export async function publishTimeline(state:string,topic:Topic,signal:AbortSignal){
  while(!signal.aborted){
    await collectDeploymentProgress(state,topic);
    if(!await publishProgress(state,topic))await delay(1000,undefined,{signal}).catch(()=>{});
  }
}

export function pendingProgress(state:string) {
  const db=open(state);
  try{return db.prepare('SELECT issue,key,body,status,retryAt FROM events WHERE receipt IS NULL ORDER BY rowid').all();}
  finally{db.close();}
}

// A restored database may lag GitHub. A missing or edited authenticated handoff cannot authorize a replay.
export async function reconcileProgress(state:string,topic:Topic,issue:number,credentials=async():Promise<[Api,number]>=>Promise.all([
  issueClient(topic.repository,topic.installation),publisherIdentity(topic.repository,topic.installation)])){
  const db=open(state);
  try{
    const [api,bot]=await credentials();
    if((await api('')).id!==topic.repoId)throw Error('Timeline reconciliation repository mismatch');
    const rows=db.prepare('SELECT key,body,receipt FROM events WHERE issue=?').all(issue);
    const local=new Map(rows.map(r=>[String(r.key),r]));
    const confirmed=new Set<string>();
    const target='https://api.github.com/repos/'+topic.repository+'/issues/'+issue;
    for(let page=1;;page++){
      const comments:Comment[]=await api('/issues/'+issue+'/comments?per_page=100&page='+page);
      for(const item of comments){
        if(item.user?.id!==bot || item.issue_url!==target)continue;
        const key=/<!-- jam-bot:progress:([0-9a-f]{64}) -->$/.exec(item.body)?.[1];
        if(!key)continue;
        const record=local.get(key);
        if(!record || record.body!==item.body || (record.receipt!==null && record.receipt!==item.id) || confirmed.has(key))
          throw Error('Source work card and local handoff disagree; reconcile before dispatch');
        confirmed.add(key);
        if(record.receipt===null)db.prepare("UPDATE events SET receipt=?,status='sent' WHERE issue=? AND key=?").run(item.id,issue,key);
      }
      if(comments.length<100)break;
    }
    if(rows.some(r=>r.receipt!==null && !confirmed.has(String(r.key))))throw Error('A confirmed work card handoff is missing; reconcile before dispatch');
  }finally{db.close();}
}
