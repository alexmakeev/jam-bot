import { randomUUID, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runTeammate } from './native-teammate.js';
import type { Intake, Topic } from './intake-journal.js';
import { appReader } from './github-app.js';
import { checkCurrentRole } from './github-authorization.js';
import { parseProfileCard } from './profile-card.js';
import { markApproved, setCardProgress, completeCard } from './profile-publication.js';
import { runDeveloperProfile } from './developer-profile.js';
import { atomicJson } from './storage.js';

export const WORKER_ACCEPTANCE_BODY = 'I approve the local JAM-Bot routing acceptance test for this issue. After the discussion is locked, have the repository coordinator delegate one checksum task to a local developer. Record the developer identity and verified result in the repository journal.';

export function isWorkerAcceptanceCard(body: string): boolean {
  return body === WORKER_ACCEPTANCE_BODY || !!parseProfileCard(body);
}

// The developer can only send messages. The service independently verifies its answer.
export async function dispatchApprovedWorker(event: Intake, topic: Topic, state: string, signal: AbortSignal, lead: string) {
  if (!event.actorId || !event.actorLogin || !isWorkerAcceptanceCard(event.body)) throw new Error('Missing approved work card');
  const authorize = async () => {
    const read = await appReader(topic.repository, String(topic.installation));
    const repoPath = 'repos/' + topic.repository;
    const [repository, role, issue] = await Promise.all([
      read(repoPath), read(repoPath + '/collaborators/' + encodeURIComponent(event.actorLogin!) + '/permission'),
      read(repoPath + '/issues/' + event.issue)
    ]);
    checkCurrentRole({id:event.actorId!, login:event.actorLogin!, type:'User'}, repository, role);
    if (repository.id !== topic.repoId || issue.number !== event.issue || issue.user?.id !== event.actorId ||
        issue.pull_request || issue.state !== 'open' || issue.locked !== true || issue.body !== event.body)
      throw new Error('Work card protection, author or approved scope changed');
  };
  await authorize();
  const card = parseProfileCard(event.body);
  await markApproved(topic,event.issue,card?.kind ?? 'assignment');
  try {
    if (card) {
      return await runDeveloperProfile({topic,state,lead,issue:event.issue,card,signal,authorize});
    }
    await setCardProgress(topic,event.issue,'in progress');
    const directory = join(state,'assignments',String(event.issue));
    await mkdir(directory,{recursive:true,mode:0o700});
    const digits = [...randomUUID().replaceAll('-','').slice(0,6)].map(c=>parseInt(c,16));
    const challenge = randomUUID();
    const expected = challenge + ':' + digits.reduce((a,b)=>a+b,0);
    await atomicJson(join(directory,'assignment.json'),{lead,issue:event.issue,delivery:event.delivery,challenge,digits});
    const verified = await runTeammate(state,topic.cwd,lead,event.issue,digits,challenge,expected,signal);
    await atomicJson(join(directory,'result.json'),{repository:topic.repository,issue:event.issue,delivery:event.delivery,
      lead, ...verified, answer:expected, scopeDigest:createHash('sha256').update(event.body).digest('hex')});
    await completeCard(topic,event.issue,'The local developer returned the verified checksum '+expected.split(':')[1]+'.');
  } catch (error) {
    // Status reporting can fail independently. Preserve the original cause for local review.
    await setCardProgress(topic,event.issue,'blocked').catch(()=>undefined);
    throw error;
  }
}
