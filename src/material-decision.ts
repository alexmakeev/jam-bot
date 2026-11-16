import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {appReader,GitHubRequestError} from './github-app.js';
import {checkCurrentRole,type GitHubActor} from './github-authorization.js';
import {parseTaskCard} from './profile-card.js';
import type {Intake,Topic} from './intake-journal.js';
import {responsible,type ProjectValues} from './project-values.js';
import {recordProgress,confirmedProgress} from './work-progress.js';
import {setCardProgress} from './profile-publication.js';

export interface Decision {area:string;scope:string}
function instructions(body:string){
  let fence:string|undefined;
  return body.split(/\r?\n/).map(line=>{
    const delimiter=/^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if(delimiter){if(!fence)fence=delimiter;else if(delimiter.startsWith(fence))fence=undefined;return '';}
    return fence?'':line;
  });
}
export function requestedDecision(body:string):Decision|undefined{
  const lines=instructions(body).filter(l=>l.startsWith('Decision required ['));
  if(!lines.length)return;
  const match=/^Decision required \[([\w -]{1,80})\]: (\S[^\r\n]{0,498}\S|\S)$/.exec(lines[0]!);
  if(lines.length!==1||!match)throw Error('Ambiguous material decision on Task');
  return {area:match[1]!.toLowerCase(),scope:match[2]!};
}
export function decisionKey(repoId:number,issue:number,d:Decision){return createHash('sha256').update(JSON.stringify([repoId,issue,d.area,d.scope])).digest('hex');}
export const decisionReply=/^(Approve|Decline) JAM-Bot decision ([a-f0-9]{64})\.$/;
export class DecisionPending extends Error {}
export function prepareDecisions(db:DatabaseSync){
  db.exec('CREATE TABLE IF NOT EXISTS material_decisions(issue INTEGER, digest TEXT, wake INTEGER NOT NULL DEFAULT 0, checked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(issue,digest))');
}
export function wakeDecision(db:DatabaseSync,issue:number,digest:string){
  prepareDecisions(db);
  db.exec('BEGIN IMMEDIATE');
  try{
    const changed=db.prepare('UPDATE material_decisions SET wake=wake+1 WHERE issue=? AND digest=?').run(issue,digest).changes;
    if(changed)db.prepare("UPDATE intake SET workerState='pending' WHERE issue=? AND action='task' AND workerState='waiting-decision'").run(issue);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
export function pauseDecision(db:DatabaseSync,delivery:string,issue:number,digest:string){
  const waiting=db.prepare(`UPDATE intake SET workerState=CASE WHEN EXISTS(SELECT 1 FROM material_decisions WHERE issue=? AND digest=? AND wake>checked)
    THEN 'pending' ELSE 'waiting-decision' END WHERE delivery=? AND workerState='running'`).run(issue,digest,delivery);
  if(!waiting.changes)throw Error('Decision lost worker ownership');
}
type Reader=(path:string)=>Promise<any>;
export type DecisionTask=Pick<Intake,'issue'|'actorId'|'authorId'|'authorLogin'|'title'|'body'|'kind'>;
export async function decisionEvidence(topic:Topic,event:DecisionTask,d:Decision,read:Reader){
  const base='repos/'+topic.repository,repo=await read(base);
  if(repo.id!==topic.repoId)throw Error('Decision repository identity changed');
  const url='https://api.github.com/'+base+'/issues/'+event.issue;
  async function permitted(actor:GitHubActor){
    if(actor?.type!=='User'||!Number.isSafeInteger(actor.id)||!actor.login?.match(/^[\w-]+$/))return false;
    let permission;
    try{permission=await read(base+'/collaborators/'+encodeURIComponent(actor.login)+'/permission');}
    catch(e){if(e instanceof GitHubRequestError && e.status===404)return false;throw e;}
    try{checkCurrentRole(actor,repo,permission);return true;}catch{return false;}
  }
  // The caller verifies the locked issue still matches the signed Task event before this check.
  const fullRequest=parseTaskCard(event.title,event.body,event.kind,topic.defaultClass)?.task;
  const lines=instructions(event.body);
  const proven=fullRequest===d.scope || lines.some((line,i)=>line==='Decision required ['+d.area+']: '+d.scope &&
    lines[i+1]==='I approve ['+d.area+']: '+d.scope);
  if(event.authorId&&event.authorId===event.actorId&&event.authorLogin&&proven){
    const actor={id:event.authorId,login:event.authorLogin,type:'User'};
    if(await permitted(actor))return {decision:'Approve',actor,source:'original Task'};
  }
  const digest=decisionKey(topic.repoId,event.issue,d);
  let latest:{decision:string;actor:GitHubActor;source:string}|undefined;
  for(let page=1;;page++){
    const comments=await read(base+'/issues/'+event.issue+'/comments?per_page=100&page='+page);
    for(const c of comments){
      const answer=typeof c.body==='string' && decisionReply.exec(c.body);
      if(answer&&answer[2]===digest&&c.issue_url===url&&Number.isSafeInteger(c.id)&&c.id>0&&await permitted(c.user))
        latest={decision:answer[1]!,actor:c.user as GitHubActor,source:'issue comment '+c.id};
    }
    if(comments.length<100)return latest;
  }
}
export async function requireMaterialDecision(topic:Topic,event:DecisionTask,state:string,d:Decision,profile:ProjectValues,
  deps:{read:typeof appReader;publish:typeof confirmedProgress;status:typeof setCardProgress}={read:appReader,publish:confirmedProgress,status:setCardProgress}){
  const digest=decisionKey(topic.repoId,event.issue,d);
  const db=new DatabaseSync(join(state,'intake.sqlite'));
  try{
    prepareDecisions(db);
    db.prepare('INSERT OR IGNORE INTO material_decisions(issue,digest) VALUES(?,?)').run(event.issue,digest);
    db.prepare('UPDATE material_decisions SET checked=wake WHERE issue=? AND digest=?').run(event.issue,digest);
  }finally{db.close();}
  const evidence=await decisionEvidence(topic,event,d,await deps.read(topic.repository,String(topic.installation)));
  const key='material-decision:'+digest+':'+(evidence?.source??'requested');
  const literal=(s:string)=>s.replaceAll('@','＠').replaceAll('`','′');
  const scope='`'+literal(d.area)+': '+literal(d.scope)+'`';
  const message=evidence?'Decision '+scope+' — '+evidence.decision+' by `'+evidence.actor.login+'` (GitHub user '+evidence.actor.id+', '+evidence.source+').':
    '❓ @'+responsible(profile,d.area)+' — do you approve '+scope+'? An authorized maintainer may reply with `Approve JAM-Bot decision '+digest+'.` or `Decline JAM-Bot decision '+digest+'.`';
  recordProgress(state,event.issue,key,message);await deps.publish(state,topic,event.issue,key);
  if(evidence?.decision!=='Approve'){
    await deps.status(topic,event.issue,'blocked');
    throw new DecisionPending(digest);
  }
}
