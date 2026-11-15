import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {homedir} from 'node:os';
import type {DatabaseSync} from 'node:sqlite';
import {issueClient,publisherIdentity} from './github-app.js';
import {loadProjectValues,responsible} from './project-values.js';
import {runRoleStage} from './role-harness.js';
import {mailboxReceipt} from './native-teammate.js';
import {atomicJson,readJson} from './storage.js';
import {git} from './profile-checkout.js';
import type {TopicRuntime} from './topics.js';
import type {ReviewRole} from './review-supervisor.js';

interface Notice {issue:number;revision:string;role:ReviewRole;reason:string;diagnosis:string|null;challenge:string|null;remote:number|null;attempts:number}
export function prepareReviewNotices(db:DatabaseSync){
  db.exec(`CREATE TABLE IF NOT EXISTS review_escalations(
    issue INTEGER NOT NULL,revision TEXT NOT NULL,role TEXT NOT NULL,reason TEXT NOT NULL,
    challenge TEXT,diagnosis TEXT,remote INTEGER,attempts INTEGER NOT NULL DEFAULT 0,available INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(issue,revision,role))`);
}
export function queueReviewNotice(db:DatabaseSync,issue:number,revision:string,role:ReviewRole,reason:string){
  if(!Number.isSafeInteger(issue)||issue<1||!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(revision))throw Error('Invalid review escalation identity');
  db.prepare('INSERT OR IGNORE INTO review_escalations(issue,revision,role,reason) VALUES(?,?,?,?)').run(issue,revision,role,reason);
}

// Reconcile the prior format only when its durable operator record identifies this review and revision.
export async function migrateReviewNotices(runtime:TopicRuntime){
  const {journal,state}=runtime;
  for(const row of journal.db.prepare(`SELECT i.issue,r.decision FROM intake i JOIN resolutions r ON i.delivery=r.delivery
    WHERE i.workerState='review' AND i.workerReason='Native model refused this stage; preserve the candidate and reconcile before further work'
    AND NOT EXISTS(SELECT 1 FROM review_escalations e WHERE e.issue=i.issue AND e.role='consultant')
    AND r.decision LIKE 'Native Opus refused the internal pre-handoff reviewer call before spawn %'`).all()){
    const issue=Number(row.issue);
    const revision=String(row.decision).match(/Preserved corrected candidate ([a-f0-9]{40})\./)?.[1];
    if(!revision)continue;
    const correction=await readJson<{sha:string}>(join(state,'assignments',String(issue),'correction.json'));
    if(correction.sha===revision && await git(join(state,'worktrees',String(issue)),'rev-parse','HEAD')===revision)
      queueReviewNotice(journal.db,issue,revision,'consultant','The native model refused the mandatory review');
  }
}

export async function publishReviewNotice(api:Awaited<ReturnType<typeof issueClient>>,bot:number,notice:Notice,owner:string){
  const marker='<!-- jam-bot:mandatory-review:'+notice.role+':'+notice.revision+' -->';
  const path='/issues/'+notice.issue+'/comments';
  for(let page=1;;page++){
    const comments=await api(path+'?per_page=100&page='+page);
    const previous=comments.find((c:{body:string;user:{id:number}})=>c.user?.id===bot && c.body?.endsWith(marker));
    if(previous)return Number(previous.id);
    if(comments.length<100)break;
  }
  const stage=notice.role==='consultant'?'pre-handoff review':'integration review';
  const body='@'+owner+' — '+notice.reason+' during '+stage+' for candidate `'+notice.revision.slice(0,12)+'`. The required PASS is missing and publication is blocked. '+notice.diagnosis+'\n\n'+marker;
  const comment=await api(path,'POST',{body});
  if(comment?.user?.id!==bot || !Number.isSafeInteger(comment.id))throw Error('Unverified escalation publication');
  return comment.id as number;
}

export async function deliverReviewNotice(runtime:TopicRuntime,signal:AbortSignal){
  const {journal,state,topic}=runtime,db=journal.db;
  const notice=db.prepare('SELECT * FROM review_escalations WHERE remote IS NULL AND available<=unixepoch() ORDER BY available,issue LIMIT 1').get() as unknown as Notice|undefined;
  if(!notice)return;
  const ids=[notice.issue,notice.revision,notice.role] as const;
  try{
    if(!notice.diagnosis){
      let recommendation='The architect could not complete the diagnosis. Please inspect the review failure and decide how to revise the task or whether to close it.';
      const challenge=notice.challenge??randomUUID(),session=journal.lead().id;
      const name='architect-'+notice.issue+'-'+challenge.slice(0,6);
      const input='Diagnose a mandatory internal reviewer availability incident. You receive operational metadata only. The review is blocked and has no PASS. An explicit refusal must never be retried or rerouted. You are the responsible architect. Identify the cause and the next maintainer decision; do not review or approve the code. Start with one of REVISE_SCOPE, INSPECT_RUNTIME or CLOSE_TASK followed by a short reason.\n'+JSON.stringify({issue:notice.issue,stage:notice.role,revision:notice.revision,serviceObservation:notice.reason});
      try{
        let receipt;
        if(notice.challenge)receipt=await mailboxReceipt({config:process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'),cwd:topic.cwd,session,name,challenge,agentType:'jam-architect'});
        else{
          db.prepare('UPDATE review_escalations SET challenge=? WHERE issue=? AND revision=? AND role=?').run(challenge,...ids);
          receipt=await runRoleStage({role:'architect',state,cwd:topic.cwd,session,issue:notice.issue,input,signal},challenge as ReturnType<typeof randomUUID>);
        }
        if(receipt){
          await atomicJson(join(state,'assignments',String(notice.issue),'review-diagnoses',notice.role+'-'+notice.revision+'.json'),receipt);
          const action=receipt.output.trim().replace(/^[*_`\s]+/,'').split(/[^A-Z_]/)[0];
          if(action==='REVISE_SCOPE')recommendation='The architect recommends revising the task. Please specify the intended scope in a linked Task or close this one if it is no longer needed.';
          if(action==='INSPECT_RUNTIME')recommendation='The architect recommends inspecting the review failure. Please check the reviewer incident and decide whether the task needs revised scope or should be closed.';
          if(action==='CLOSE_TASK')recommendation='The architect recommends closing this task. Please confirm by closing it or describe a revised scope in a linked Task.';
        }
      }catch(error){if(signal.aborted)throw error;}
      db.prepare('UPDATE review_escalations SET diagnosis=? WHERE issue=? AND revision=? AND role=?').run(recommendation,...ids);
      notice.diagnosis=recommendation;
    }
    const [api,bot,owner]=await Promise.all([issueClient(topic.repository,topic.installation),publisherIdentity(topic.repository,topic.installation),loadProjectValues(topic).then(profile=>responsible(profile,notice.role==='integrator'?'integration':'code review'))]);
    const remote=await publishReviewNotice(api,bot,notice,owner);
    db.prepare('UPDATE review_escalations SET remote=? WHERE issue=? AND revision=? AND role=?').run(remote,...ids);
  }catch(error){
    if(signal.aborted)return;
    db.prepare('UPDATE review_escalations SET attempts=attempts+1,available=unixepoch()+? WHERE issue=? AND revision=? AND role=?').run(Math.min(600,10*2**Math.min(6,notice.attempts)),...ids);
    console.error('Review escalation pending',topic.repository,notice.issue);
  }
}
