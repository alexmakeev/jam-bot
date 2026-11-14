import { randomUUID, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runTeammate } from './native-teammate.js';
import type { Intake, Topic } from './intake-journal.js';
import { approvalFromEvent, validateTaskApproval } from './task-approval.js';
import { parseTaskCard } from './profile-card.js';
import { markApproved, setCardProgress, completeCard } from './profile-publication.js';
import { runDeveloperProfile } from './developer-profile.js';
import { atomicJson } from './storage.js';

export const WORKER_ACCEPTANCE_BODY = 'I approve the local JAM-Bot routing acceptance test for this issue. After the discussion is locked, have the repository coordinator delegate one checksum task to a local developer. Record the developer identity and verified result in the repository journal.';

// The developer can only send messages. The service independently verifies its answer.
export async function dispatchApprovedWorker(event: Intake, topic: Topic, state: string, signal: AbortSignal, lead: string) {
  const approval=approvalFromEvent(event);
  const authorize=()=>validateTaskApproval(topic,event.issue,approval);
  await authorize();
  const card=event.body===WORKER_ACCEPTANCE_BODY ? undefined : parseTaskCard(event.title,event.body,approval.kind,topic.defaultClass);
  if(!card && event.body!==WORKER_ACCEPTANCE_BODY)throw new Error('Task scope could not be interpreted');
  await markApproved(topic,event.issue);
  try {
    if (card) {
      return await runDeveloperProfile({topic,state,lead,issue:event.issue,card,signal,authorize,approval});
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
