import {progressOwner,roleChecklist} from './role-progress.js';
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
  db.exec(`CREATE TABLE IF NOT EXISTS dashboards(issue INTEGER PRIMARY KEY,kind TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS human_turns(issue INTEGER PRIMARY KEY,comment INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS progress_boards(issue INTEGER,key TEXT,board TEXT,owner TEXT,PRIMARY KEY(issue,key));
    CREATE TABLE IF NOT EXISTS milestones(issue INTEGER,key TEXT,summary TEXT,PRIMARY KEY(issue,key));
    CREATE TABLE IF NOT EXISTS role_updates(issue INTEGER,key TEXT,board TEXT,identity TEXT,summary TEXT,PRIMARY KEY(issue,key));
    CREATE TABLE IF NOT EXISTS event_reports(issue INTEGER,key TEXT,purpose TEXT,digest TEXT,markdown TEXT,PRIMARY KEY(issue,key,purpose,digest));
    CREATE TABLE IF NOT EXISTS event_links(issue INTEGER,key TEXT,name TEXT,url TEXT,PRIMARY KEY(issue,key,name,url));
    CREATE TABLE IF NOT EXISTS event_versions(issue INTEGER,key TEXT,body TEXT,PRIMARY KEY(issue,key,body))`);
  if(!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name='version'").get())db.exec('ALTER TABLE events ADD COLUMN version INTEGER NOT NULL DEFAULT 0;');
  return db;
}
type Report={purpose:ArtifactKind;markdown:string};
type Link={name:string;url:string};
const dashboard=fingerprint('work-card-dashboard:v1');
export function beginDashboard(state:string,issue:number,kind:string){
  const db=open(state);
  try{db.prepare('INSERT OR IGNORE INTO dashboards SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM events WHERE issue=?)').run(issue,kind==='development'?'development/roles':kind,issue);
    if(!db.prepare('SELECT 1 FROM dashboards WHERE issue=?').get(issue))return;}
  finally{db.close();}
  recordProgress(state,issue,'card-accepted','Task and human approval verified.');
}
export function startHumanTurn(state:string,issue:number,comment:number){
  const db=open(state);
  try{
    db.prepare(`INSERT INTO human_turns SELECT ?,? WHERE EXISTS(SELECT 1 FROM dashboards WHERE issue=?)
      ON CONFLICT(issue) DO UPDATE SET comment=MAX(comment,excluded.comment)`).run(issue,comment,issue);
  }finally{db.close();}
}
function eventKey(db:DatabaseSync,issue:number,identity:string){
  const key=fingerprint(identity);
  const segment=db.prepare('SELECT board FROM progress_boards WHERE issue=? AND key=?').get(issue,key);
  if(segment)return String(segment.board);
  const role=db.prepare('SELECT board FROM role_updates WHERE issue=? AND key=?').get(issue,key);
  if(role)return String(role.board);
  return db.prepare('SELECT 1 FROM milestones WHERE issue=? AND key=?').get(issue,key)?dashboard:key;
}
export function recordProgress(state:string,issue:number,identity:string,summary:string,report?:Report|Report[],links:Link[]=[]){
  const db=open(state);
  try{
    db.exec('BEGIN IMMEDIATE');
    let key=fingerprint(identity);
    const board=db.prepare('SELECT kind FROM dashboards WHERE issue=?').get(issue);
    let changed=false;
    const legacy=db.prepare('SELECT 1 FROM events WHERE issue=? AND key=?').get(issue,key);
    const routine=board && !legacy;
    const segment=(owner:string,original:string)=>{
      const mapped=eventKey(db,issue,identity);
      if(mapped!==key)return mapped;
      const turn=db.prepare('SELECT comment FROM human_turns WHERE issue=?').get(issue);
      const target=turn?fingerprint(original+':after:'+turn.comment):original;
      db.prepare('INSERT OR IGNORE INTO progress_boards VALUES(?,?,?,?)').run(issue,key,target,owner);
      return target;
    };
    if(routine && board.kind==='development/roles'){
      const previous=(identity.startsWith('blocked:')||identity.startsWith('material-decision:'))?db.prepare('SELECT identity FROM role_updates WHERE issue=? ORDER BY rowid DESC LIMIT 1').get(issue):undefined;
      const owner=progressOwner(previous?String(previous.identity):identity);
      const boardKey=segment(owner,fingerprint('work-card-role:'+owner));
      changed=Boolean(db.prepare('INSERT OR IGNORE INTO role_updates VALUES(?,?,?,?,?)').run(issue,key,boardKey,identity,summary).changes);
      key=boardKey;
      const rows=db.prepare('SELECT identity,summary FROM role_updates WHERE issue=? AND board=? ORDER BY rowid').all(issue,key);
      summary=roleChecklist(owner,rows.map(row=>({identity:String(row.identity),summary:String(row.summary)})));
    }else if(routine){
      const boardKey=segment('JAM',dashboard);
      changed=Boolean(db.prepare('INSERT OR IGNORE INTO milestones VALUES(?,?,?)').run(issue,key,summary).changes);
      const history=db.prepare('SELECT key,summary FROM milestones WHERE issue=? ORDER BY rowid').all(issue);
      const latest=history.slice(-5);
      const done=Boolean(db.prepare('SELECT 1 FROM milestones WHERE issue=? AND key=?').get(issue,fingerprint('card-result-verified')));
      const active=latest.some(r=>r.key!==fingerprint('card-accepted'));
      const block=/paused|blocked|waiting for project profile/i.test(String(latest.at(-1)?.summary));
      const work=board.kind==='development'?'Implement and verify the change':board.kind==='consultation'?'Prepare the consultation':'Prepare the assignment';
      summary='**JAM · work card progress**\n\n✅ Task accepted  \n'+(done?'✅':block?'⏸️':active?'🟨':'◻️')+' '+work+'  \n'+(done?'✅':'◻️')+' Deliver the verified result'+
        '\n\n**Latest updates**\n'+latest.map(row=>'- '+row.summary).join('\n');
      const earlier=history.slice(0,-5).map(row=>'- '+row.summary).join('\n');
      if(earlier && earlier.length+summary.length<45000)summary+='\n\n<details><summary>Earlier updates</summary>\n\n'+earlier+'\n\n</details>';
      key=boardKey;
    }
    const body=summary+'\n\n<!-- jam-bot:progress:'+key+' -->';
    db.prepare('INSERT OR IGNORE INTO events(issue,key,body) VALUES(?,?,?)').run(issue,key,body);
    if(routine && changed)db.prepare('UPDATE events SET body=? WHERE issue=? AND key=?').run(body,issue,key);
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
// A periodic publisher and a synchronous handoff can target the same comment.
const publishing=new Map<string,Promise<boolean>>();
export async function publishProgress(state:string,topic:Topic,credentials=()=>session(topic),selection?:{issue:number;key:string}){
  const previous=publishing.get(state);
  const run=(previous??Promise.resolve()).catch(()=>{}).then(()=>publishOne(state,topic,credentials,selection));
  publishing.set(state,run);
  try{return await run;}finally{if(publishing.get(state)===run)publishing.delete(state);}
}
async function publishOne(state:string,topic:Topic,credentials:()=>Promise<[Api,number]>,selection?:{issue:number;key:string}){
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
      const roleBoard=/^\*\*(Architect|Worker|Integrator):/.test(base);
      const primaryOrder=base.startsWith('**Worker:')?['tests-','review-']:['integration-','spec-','plan-','tests-','review-'];
      const primary=primaryOrder.map(prefix=>files.filter(file=>file.name.startsWith(prefix)).at(-1)).find(Boolean);
      const selected=roleBoard?(primary?[primary]:[]):files;
      const body=selected.length?base.slice(0,-marker.length).trimEnd()+(base.startsWith('**')?'\n\n**Files:** ':' ')+selected.map(f=>'['+f.name+']('+f.url+')').join(' · ')+'\n\n'+marker:base;
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
  // Re-render existing role comments from their stored evidence after a format upgrade.
  const db=open(state);
  try{
    db.exec('BEGIN IMMEDIATE');
    for(const row of db.prepare('SELECT DISTINCT issue,board FROM role_updates').all()){
      if(db.prepare('SELECT 1 FROM human_turns WHERE issue=?').get(row.issue!))continue;
      const history=db.prepare('SELECT identity,summary FROM role_updates WHERE issue=? AND board=? ORDER BY rowid').all(row.issue!,row.board!).map(r=>({identity:String(r.identity),summary:String(r.summary)}));
      const owner=(['Architect','Worker','Integrator'] as const).find(role=>fingerprint('work-card-role:'+role)===row.board);
      if(!owner)continue;
      const body=roleChecklist(owner,history)+'\n\n<!-- jam-bot:progress:'+row.board+' -->';
      db.prepare("UPDATE events SET body=?,version=version+1,status=CASE WHEN receipt IS NULL THEN status ELSE 'dirty' END,retryAt=0 WHERE issue=? AND key=? AND body<>?").run(body,row.issue!,row.board!,body);
    }
    db.exec('COMMIT');
  }finally{db.close();}
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
  const lookup=open(state);let key:string;try{key=eventKey(lookup,issue,identity);}finally{lookup.close();}
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
  try{return Number(db.prepare("SELECT receipt FROM events WHERE issue=? AND key=? AND status='sent'").get(issue,eventKey(db,issue,identity))?.receipt??0);}
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
  try{return Boolean(db.prepare('SELECT 1 FROM events WHERE issue=? AND key=?').get(issue,eventKey(db,issue,identity)));}
  finally{db.close();}
}
