import {DatabaseSync} from 'node:sqlite';
import { issueComment } from './issue-comment.js';
import { digestOf, specName } from './specification-upload.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {publishIssueSpec} from './issue-specification.js';
import {recordProgress,confirmedProgress,fingerprint,storedResultComment,reconcileProgress} from './work-progress.js';
import {atomicJson,readJson} from './storage.js';
import { GitHubRequestError, issueClient, publisherIdentity } from './github-app.js';
import type { Topic } from './intake-journal.js';

const stages = ['queued','planning','in progress','in validation','blocked'] as const;
type Stage = typeof stages[number];
const statusLabel = (stage: Stage) => 'status:'+stage.replaceAll(' ','-');
const progressLabels = new Set(stages.map(statusLabel));

export async function setCardProgress(topic: Topic, issue: number, status: Stage, add: string[] = []) {
  const api = await issueClient(topic.repository,topic.installation);
  const path = '/issues/'+issue+'/labels';
  const current: {name:string}[] = await api(path+'?per_page=100');
  const desired = [statusLabel(status),...add];
  const missing = desired.filter(name => !current.some(label=>label.name===name));
  if (missing.length) await api(path,'POST',{labels:missing});
  for (const label of current) {
    if (label.name!==statusLabel(status) && progressLabels.has(label.name)) {
      await api(path+'/'+encodeURIComponent(label.name),'DELETE');
    }
  }
}

export async function markApproved(topic: Topic, issue: number) {
  await setCardProgress(topic,issue,'queued');
}

async function authenticatedComment(topic:Topic,issue:number,body:string,lookupOnly=false){
  const [api,publisher]=await Promise.all([issueClient(topic.repository,topic.installation),publisherIdentity(topic.repository,topic.installation)]);
  const path='/issues/'+issue+'/comments';
  const target='https://api.github.com/repos/'+topic.repository+'/issues/'+issue;
  if((await api('')).id!==topic.repoId)throw Error('Work card repository identity changed');
  const db=new DatabaseSync(join(dirname(topic.cwd),'issue-actions.sqlite'));
  try{
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS comments(issue INTEGER,digest TEXT,receipt INTEGER,PRIMARY KEY(issue,digest))');
    const digest=digestOf(body);
    for(let page=1;;page++){
      const rows:{id:number;user:{id:number};body:string;issue_url:string}[]=await api(path+'?per_page=100&page='+page);
      const found=rows.find(c=>c.user?.id===publisher && c.body===body && c.issue_url===target);
      if(found){
        db.prepare('INSERT INTO comments VALUES(?,?,?) ON CONFLICT(issue,digest) DO UPDATE SET receipt=excluded.receipt').run(issue,digest,found.id);
        return true;
      }
      if(rows.length<100)break;
    }
    if(lookupOnly)return false;
    if(!db.prepare('INSERT OR IGNORE INTO comments(issue,digest) VALUES(?,?)').run(issue,digest).changes)
      throw Error('Work card publication is awaiting reconciliation');
    try{
      const published=await api(path,'POST',{body});
      if(published.user?.id!==publisher || published.body!==body || published.issue_url!==target || !Number.isSafeInteger(published.id))throw Error('Work card publication could not be verified');
      db.prepare('UPDATE comments SET receipt=? WHERE issue=? AND digest=?').run(published.id,issue,digest);
    }catch(err){
      if(err instanceof GitHubRequestError && [400,401,403,404,422,429].includes(err.status))
        db.prepare('DELETE FROM comments WHERE issue=? AND digest=? AND receipt IS NULL').run(issue,digest);
      throw err;
    }
    return true;
  }finally{db.close();}
}
export async function requestFileScope(topic:Topic,issue:number,plan:string) {
  issueComment('needs-files',plan);
  const state=dirname(topic.cwd),key='scope-plan:'+fingerprint(plan);
  recordProgress(state,issue,key,'The architect completed the implementation plan. Create a linked Task listing the approved file paths before development.',{purpose:'plan',markdown:plan});
  await confirmedProgress(state,topic,issue,key);
  await setCardProgress(topic,issue,'blocked');
}

export async function completeCard(topic: Topic, issue: number, summary: string, existingResult?:string) {
  const api = await issueClient(topic.repository,topic.installation);
  const path = '/issues/'+issue;
  if(existingResult)await confirmedProgress(dirname(topic.cwd),topic,issue,existingResult);
  else await authenticatedComment(topic,issue,issueComment('completion',summary));
  if((await api(path)).state!=='closed')
  await api(path,'PATCH',{state:'closed',state_reason:'completed'});
  const labels: {name:string}[] = await api(path+'/labels?per_page=100');
  for (const label of labels.filter(label=>progressLabels.has(label.name))) {
    try { await api(path+'/labels/'+encodeURIComponent(label.name),'DELETE'); }
    catch(error) { if (!(error instanceof GitHubRequestError && error.status===404)) throw error; }
  }
}

// Stage the exact architect bytes locally and confirm the copy attached to the original work card.
export async function publishSpecification({topic,issue,markdown,signal,authorize}: {
  topic:Topic;issue:number;markdown:string;signal:AbortSignal;authorize:()=>Promise<void>
}) {
  const state=dirname(topic.cwd);
  const name=specName(issue,digestOf(markdown));
  const directory=join(state,'assignments',String(issue),'attachments');
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(join(directory,name),markdown,{mode:0o600});
  const [api,bot]=await Promise.all([issueClient(topic.repository,topic.installation),publisherIdentity(topic.repository,topic.installation)]);
  const artifact=await publishIssueSpec(state,topic.repository,topic.repoId,issue,markdown,bot,api,authorize,signal,undefined,true);
  const handoff=await readJson<{identity:string;role:string}>(join(state,'assignments',String(issue),'handoffs',fingerprint(markdown)+'.json')).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
  const key=handoff?.role==='architect'?handoff.identity:'specification:'+artifact.sha256;
  recordProgress(state,issue,key,'The '+(markdown.startsWith('# Correction for issue ')?'integrator delivered correction guidance':'architect delivered the specification')+' for this work card.',undefined,[artifact]);
  const commentId=await confirmedProgress(state,topic,issue,key);
  const receipt={...artifact,commentId};
  await atomicJson(join(directory,name+'.artifact-receipt.json'),receipt);
}

export async function publishDirectResult(topic:Topic,issue:number,kind:'assignment'|'consultation',output:string){
  issueComment('completion',output);
  const state=dirname(topic.cwd),key='direct-result:'+fingerprint(output);
  const short=output.length<=350 && !output.includes('\n');
  recordProgress(state,issue,key,short?output:'The '+kind+' is complete. The attached result contains the full response.',
    short?undefined:{purpose:kind,markdown:output});
  return key;
}

export async function hasClosedResult(topic:Topic,issue:number,summary:string){
  const api=await issueClient(topic.repository,topic.installation);
  const card=await api('/issues/'+issue);
  if(card.number!==issue || card.state!=='closed' || card.state_reason!=='completed')return false;
  const state=dirname(topic.cwd),key='direct-result:'+fingerprint(summary);
  if(storedResultComment(state,issue,key)){await reconcileProgress(state,topic,issue);return true;}
  return authenticatedComment(topic,issue,issueComment('completion',summary),true);
}
