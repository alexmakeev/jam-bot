import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {collectDeploymentProgress} from './deployment-progress.js';
import {publishIssueSpec,type ArtifactKind} from './issue-specification.js';
import {issueClient,publisherIdentity} from './github-app.js';
import type {Topic} from './intake-journal.js';

export const fingerprint=(input:string)=>createHash('sha256').update(input).digest('hex');
function open(state:string) {
  const db=new DatabaseSync(join(state,'work-progress.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS events(issue INTEGER,key TEXT,body TEXT,status TEXT DEFAULT 'pending',
    receipt INTEGER,retryAt INTEGER DEFAULT 0,PRIMARY KEY(issue,key))`);
  if(!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name='markdown'").get())db.exec('ALTER TABLE events ADD COLUMN markdown TEXT; ALTER TABLE events ADD COLUMN purpose TEXT;');
  db.exec(`CREATE TABLE IF NOT EXISTS event_reports(issue INTEGER,key TEXT,purpose TEXT,digest TEXT,markdown TEXT,PRIMARY KEY(issue,key,purpose,digest));
    CREATE TABLE IF NOT EXISTS event_links(issue INTEGER,key TEXT,name TEXT,url TEXT,PRIMARY KEY(issue,key,name,url));
    CREATE TABLE IF NOT EXISTS event_versions(issue INTEGER,key TEXT,body TEXT,PRIMARY KEY(issue,key,body))`);
  if(!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name='version'").get())db.exec('ALTER TABLE events ADD COLUMN version INTEGER NOT NULL DEFAULT 0;');
  return db;
}
type Report={purpose:ArtifactKind;markdown:string};
type Link={name:string;url:string};
export function recordProgress(state:string,issue:number,identity:string,summary:string,report?:Report|Report[],links:Link[]=[]){
  const db=open(state);
  try{
    db.exec('BEGIN IMMEDIATE');
    const key=fingerprint(identity),body=summary+'\n\n<!-- jam-bot:progress:'+key+' -->';
    db.prepare('INSERT OR IGNORE INTO events(issue,key,body) VALUES(?,?,?)').run(issue,key,body);
    let changed=false;
    for(const r of !report?[]:Array.isArray(report)?report:[report]){
      if(db.prepare('INSERT OR IGNORE INTO event_reports VALUES(?,?,?,?,?)').run(issue,key,r.purpose,fingerprint(r.markdown),r.markdown).changes)changed=true;
    }
    for(const link of links){
      if(!/^[a-z0-9][a-z0-9_.-]*\.md$/i.test(link.name) || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*\/artifacts\/[1-9][0-9]*$/.test(link.url))throw Error('Invalid issue artifact link');
      if(db.prepare('INSERT OR IGNORE INTO event_links VALUES(?,?,?,?)').run(issue,key,link.name,link.url).changes)changed=true;
    }
    if(changed)db.prepare("UPDATE events SET version=version+1,status=CASE WHEN receipt IS NULL THEN status ELSE 'dirty' END,retryAt=0 WHERE issue=? AND key=?").run(issue,key);
    db.exec('COMMIT');
  }finally{db.close();}
}
type Api=Awaited<ReturnType<typeof issueClient>>;
type Comment={id:number;user:{id:number};body:string;issue_url:string};
const sessions=new Map<string,{expires:number;value:Promise<[Api,number]>}>();
function session(topic:Topic):Promise<[Api,number]>{
  const key=topic.installation+'/'+topic.repoId+'/'+topic.repository;
  const cached=sessions.get(key);
  if(cached && Date.now()<cached.expires)return cached.value;
  const value:Promise<[Api,number]>=Promise.all([issueClient(topic.repository,topic.installation),publisherIdentity(topic.repository,topic.installation)]);
  sessions.set(key,{expires:Date.now()+45*60_000,value});
  void value.catch(()=>{if(sessions.get(key)?.value===value)sessions.delete(key);});
  return value;
}
export async function publishProgress(state:string,topic:Topic,credentials=()=>session(topic),selection?:{issue:number;key:string}){
  const db=open(state);
  try{
    const event=selection?db.prepare("SELECT * FROM events WHERE issue=? AND key=? AND status!='sent'").get(selection.issue,selection.key):
      db.prepare("SELECT * FROM events WHERE status!='sent' AND retryAt<=unixepoch() ORDER BY rowid LIMIT 1").get();
    if(!event)return false;
    const issue=Number(event.issue),key=String(event.key),base=String(event.body);
    const path='/issues/'+issue+'/comments';
    const issueUrl='https://api.github.com/repos/'+topic.repository+'/issues/'+issue;
    try{
      const [api,bot]=await credentials();
      if((await api('')).id!==topic.repoId)throw Error('Work card repository identity changed');
      const reports=db.prepare('SELECT purpose,markdown FROM event_reports WHERE issue=? AND key=? ORDER BY rowid').all(issue,key);
      if(typeof event.markdown==='string' && !reports.some(r=>r.markdown===event.markdown))reports.push({purpose:event.purpose!,markdown:event.markdown});
      const files=db.prepare('SELECT name,url FROM event_links WHERE issue=? AND key=? ORDER BY rowid').all(issue,key).map(f=>({name:String(f.name),url:String(f.url)}));
      for(const report of reports){
        const artifact=await publishIssueSpec(state,topic.repository,topic.repoId,issue,String(report.markdown),bot,api,async()=>{},new AbortController().signal,report.purpose as Report['purpose'],true);
        if(!files.some(f=>f.url===artifact.url))files.push(artifact);
      }
      const marker='<!-- jam-bot:progress:'+key+' -->';
      if(files.some(f=>!f.url.startsWith('https://github.com/'+topic.repository+'/issues/'+issue+'/artifacts/')))throw Error('Result artifact belongs to another work card');
      const body=files.length?base.slice(0,-marker.length).trimEnd()+' '+files.map(f=>'['+f.name+']('+f.url+')').join(' · ')+'\n\n'+marker:base;
      db.prepare('INSERT OR IGNORE INTO event_versions VALUES(?,?,?)').run(issue,key,body);
      let received:Comment|undefined;
      if(event.receipt!==null){
        received=await api('/issues/comments/'+event.receipt);
        if(!received || received.id!==event.receipt || received.user?.id!==bot || received.issue_url!==issueUrl)throw Error('Saved result belongs to another issue or publisher');
      }
      for(let page=1;event.receipt===null;page++){
        const rows:Comment[]=await api(path+'?per_page=100&page='+page);
        const matching=rows.filter(c=>c.user?.id===bot && c.body?.endsWith(marker) && c.issue_url===issueUrl);
        if(matching.length+(received?1:0)>1)throw Error('Duplicate work progress evidence');
        received??=matching[0];
        if(rows.length<100)break;
      }
      if(received && (event.receipt!==null && event.receipt!==received.id))throw Error('Result comment identity changed');
      if(received && received.body!==body){
        if(received.body!==base && !db.prepare('SELECT 1 FROM event_versions WHERE issue=? AND key=? AND body=?').get(issue,key,received.body))throw Error('Owned result comment was edited externally');
        received=await api('/issues/comments/'+received.id,'PATCH',{body});
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
      db.prepare("UPDATE events SET receipt=?,status=CASE WHEN version=? THEN 'sent' ELSE 'dirty' END WHERE issue=? AND key=?").run(received.id,event.version!,issue,key);
    } catch(error) {
      if((error as {status?:number}).status===401)sessions.delete(topic.installation+'/'+topic.repoId+'/'+topic.repository);
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
  try{return db.prepare("SELECT issue,key,body,status,retryAt FROM events WHERE status!='sent' ORDER BY rowid").all();}
  finally{db.close();}
}

// A restored database may lag GitHub. A missing or edited authenticated handoff cannot authorize a replay.
export async function reconcileProgress(state:string,topic:Topic,issue:number,credentials=()=>session(topic)){
  const db=open(state);
  try{
    const [api,bot]=await credentials();
    if((await api('')).id!==topic.repoId)throw Error('Timeline reconciliation repository mismatch');
    const rows=db.prepare('SELECT key,body,receipt,status FROM events WHERE issue=?').all(issue);
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
        if(!record || (record.body!==item.body && !db.prepare('SELECT 1 FROM event_versions WHERE issue=? AND key=? AND body=?').get(issue,key,item.body)) || (record.receipt!==null && record.receipt!==item.id) || confirmed.has(key))
          throw Error('Source work card and local handoff disagree; reconcile before dispatch');
        confirmed.add(key);
        if(record.receipt===null)db.prepare("UPDATE events SET receipt=? WHERE issue=? AND key=?").run(item.id,issue,key);
      }
      if(comments.length<100)break;
    }
    for(const row of rows.filter(r=>r.receipt!==null && !confirmed.has(String(r.key)))){
      if(row.status==='dirty'){
        const old=await api('/issues/comments/'+row.receipt);
        if(old?.id===row.receipt && old.user?.id===bot && old.issue_url===target && db.prepare('SELECT 1 FROM event_versions WHERE issue=? AND key=? AND body=?').get(issue,String(row.key),String(old.body)))continue;
      }
      throw Error('A confirmed work card handoff is missing; reconcile before dispatch');
    }
  }finally{db.close();}
}

export async function confirmedProgress(state:string,topic:Topic,issue:number,identity:string) {
  const key=fingerprint(identity);
  for(let attempt=0;attempt<6;attempt++){
    await publishProgress(state,topic,undefined,{issue,key});
    const db=open(state);
    try{
      const row=db.prepare("SELECT receipt FROM events WHERE issue=? AND key=? AND status='sent'").get(issue,key);
      if(row?.receipt)return Number(row.receipt);
    }finally{db.close();}
    if(attempt<5)await delay(2000);
  }
  throw Error('Work card result publication requires reconciliation');
}

export function storedResultComment(state:string,issue:number,identity:string) {
  const db=open(state);
  try{return Number(db.prepare("SELECT receipt FROM events WHERE issue=? AND key=? AND status='sent'").get(issue,fingerprint(identity))?.receipt??0);}
  finally{db.close();}
}

export function adoptVerifiedLegacyResult(state:string,issue:number,identity:string,id:number,body:string){
  const db=open(state),key=fingerprint(identity);
  try{
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT OR IGNORE INTO event_versions VALUES(?,?,?)').run(issue,key,body);
    db.prepare("UPDATE events SET receipt=?,status='dirty' WHERE issue=? AND key=? AND receipt IS NULL AND status='pending'").run(id,issue,key);
    db.exec('COMMIT');
  }finally{db.close();}
}

export function hasProgressIdentity(state:string,issue:number,identity:string){
  const db=open(state);
  try{return Boolean(db.prepare('SELECT 1 FROM events WHERE issue=? AND key=?').get(issue,fingerprint(identity)));}
  finally{db.close();}
}
