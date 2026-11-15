import { issueComment } from './issue-comment.js';
import { digestOf, specName } from './specification-upload.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {publishIssueSpec} from './issue-specification.js';
import {atomicJson} from './storage.js';
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

export async function requestFileScope(topic:Topic,issue:number,plan:string) {
  const api=await issueClient(topic.repository,topic.installation);
  const marker='<!-- jam-bot:needs-files -->';
  const comments:{body:string}[]=await api('/issues/'+issue+'/comments?per_page=100');
  if(!comments.some(c=>c.body?.endsWith(marker))){
    await api('/issues/'+issue+'/comments','POST',{body:issueComment('needs-files',plan)});
  }
  await setCardProgress(topic,issue,'blocked');
}

export async function completeCard(topic: Topic, issue: number, summary: string) {
  const api = await issueClient(topic.repository,topic.installation);
  const path = '/issues/'+issue;
  const marker = '<!-- jam-bot:completion -->';
  const existing: {body:string}[] = await api(path+'/comments?per_page=100');
  if (!existing.some(c=>c.body?.endsWith(marker))) {
    await api(path+'/comments','POST',{body:issueComment('completion',summary)});
  }
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
  const receipt=await publishIssueSpec(state,topic.repository,topic.repoId,issue,markdown,bot,api,authorize,signal);
  await atomicJson(join(directory,name+'.artifact-receipt.json'),receipt);
}
