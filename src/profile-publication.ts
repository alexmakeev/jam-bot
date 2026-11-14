import { attachmentUrl, digestOf, specName } from './specification-upload.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GitHubRequestError, issueClient } from './github-app.js';
import type { Topic } from './intake-journal.js';
import type { ProfileCard } from './profile-card.js';

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

export async function markApproved(topic: Topic, issue: number, kind: ProfileCard['kind']) {
  await setCardProgress(topic,issue,'queued',['kind:task','approval:approved','class:'+kind]);
}

export async function completeCard(topic: Topic, issue: number, summary: string) {
  const api = await issueClient(topic.repository,topic.installation);
  const path = '/issues/'+issue;
  const marker = '<!-- jam-bot:completion -->';
  const existing: {body:string}[] = await api(path+'/comments?per_page=100');
  if (!existing.some(c=>c.body?.endsWith(marker))) {
    await api(path+'/comments','POST',{body:summary.replace(/\s+/g,' ').trim().slice(0,1400)+'\n\n'+marker});
  }
  await api(path,'PATCH',{state:'closed',state_reason:'completed'});
  const labels: {name:string}[] = await api(path+'/labels?per_page=100');
  for (const label of labels.filter(label=>progressLabels.has(label.name))) {
    try { await api(path+'/labels/'+encodeURIComponent(label.name),'DELETE'); }
    catch(error) { if (!(error instanceof GitHubRequestError && error.status===404)) throw error; }
  }
}

// GitHub's web form accepts Markdown attachments. The public CLI upload endpoint
// currently restricts uploads to media. Verify the operator's attachment in the original issue.
export async function publishSpecification({topic,issue,markdown,signal}: {
  topic:Topic;issue:number;markdown:string;signal:AbortSignal
}) {
  const api = await issueClient(topic.repository,topic.installation);
  const digest = digestOf(markdown);
  const name = specName(issue,digest);
  const directory = join(dirname(topic.cwd),'assignments',String(issue),'attachments');
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(join(directory,name),markdown,{mode:0o600});
  // The local uploader prepares this receipt after verifying the uploaded bytes.
  // Waiting for the file uses no GitHub requests or model calls.
  const ticket = join(directory,name+'.receipt.json');
  for (;;) {
    const raw = await readFile(ticket,'utf8').catch((error:NodeJS.ErrnoException)=>{
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    if (raw) {
      const receipt = JSON.parse(raw) as {sha256:string;commentId:number;url:string};
      if (receipt.sha256!==digest || !Number.isSafeInteger(receipt.commentId) || receipt.commentId<=0 ||
          !/^https:\/\/github\.com\/user-attachments\/(?:files\/\d+\/[\w.%-]+|assets\/[a-f0-9-]+)$/.test(receipt.url)) {
        throw new Error('Invalid attachment verification record');
      }
      const [repo,comment] = await Promise.all([api(''),api('/issues/comments/'+receipt.commentId)]);
      if (comment.issue_url!=='https://api.github.com/repos/'+topic.repository+'/issues/'+issue ||
          comment.user?.id!==repo.owner?.id || attachmentUrl(String(comment.body),name)!==receipt.url) {
        throw new Error('Specification attachment is missing from the original work card');
      }
      return;
    }
    await delay(1500,undefined,{signal});
  }
}
