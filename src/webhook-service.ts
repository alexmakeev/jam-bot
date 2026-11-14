import { readdir, readFile, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Journal } from './intake-journal.js';
import { approvalFromEvent, validateTaskApproval } from './task-approval.js';
import { notifyLeo } from './leo-intake.js';
import { dispatchApprovedWorker } from './approved-worker.js';
import { configuredTopics, openTopics, type TopicRuntime } from './topics.js';
import { IntegrationQueue } from './integration-queue.js';
import { BranchValidation } from './branch-validation.js';
import { integrateReady, validateReviewedHead } from './developer-profile.js';
import { webhook } from './webhook.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Missing '+name);
  return value;
}
async function requireOwnerLock(path: string) {
  for (const fd of await readdir('/proc/self/fd')) {
    const target = await readlink('/proc/self/fd/'+fd).catch(()=>null);
    if (target === path && /FLOCK\s+ADVISORY\s+WRITE/.test(await readFile('/proc/self/fdinfo/'+fd,'utf8'))) return;
  }
  throw new Error('Start the service under flock -n -F '+path);
}
async function consume({journal,topic,state}: TopicRuntime, signal: AbortSignal) {
  const integrations=new IntegrationQueue(journal.db);
  const validations=new BranchValidation(journal.db);
  validations.recover();
  const runtime={journal,topic,state};
  try {
    while (!signal.aborted) {
      const decision=validations.tick(integrations,head=>validateReviewedHead(runtime,head,signal),signal);
      if(decision.batch) {await integrateReady(runtime,signal,integrations,decision.batch);continue;}
      if(decision.waiting) {await delay(250);continue;}
      const execution = journal.nextWorker();
      if (execution) {
        try {
          await dispatchApprovedWorker(execution,topic,state,signal,journal.lead().id);
          journal.finishWorker(execution.delivery);
        } catch (err) {
          journal.finishWorker(execution.delivery,err instanceof Error ? err.message : 'Worker dispatch failed');
          console.error('Worker dispatch requires review',topic.repository,execution.issue);
        }
        continue;
      }
      const event = journal.next();
      if (!event) { await delay(500); continue; }
      try {
        if(event.action==='task')await validateTaskApproval(topic,event.issue,approvalFromEvent(event),true);
        const ack = await notifyLeo(event,journal.lead(),topic.cwd,topic.repository,signal);
        journal.complete(ack);
        console.log('Leo acknowledged issue',topic.repository,event.issue);
      } catch (err) {
        journal.fail(event.delivery,err instanceof Error ? err.message : 'Dispatch failed');
        console.error('Leo intake requires review',topic.repository,event.issue);
      }
    }
  } finally { await validations.settle(); }
}
async function main() {
  const state = resolve(required('JAM_STATE_DIR'));
  const [cmd,action,id,decision,operator,session] = process.argv.slice(2);
  if (cmd === 'review') {
    const selector = process.env.JAM_REVIEW_REPOSITORY || required('JAM_REPOSITORY');
    const route = configuredTopics(state).find(route => route.topic.repository === selector);
    if (!route) throw new Error('Unconfigured review repository');
    const journal = new Journal(join(route.state,'intake.sqlite'));
    try {
      if (action==='list') console.log(JSON.stringify({repository:selector, session:journal.lead(), deliveries:journal.list()},null,2));
      else if (action==='retry-integration' && id && decision && operator) new IntegrationQueue(journal.db).retryFailed(id,operator,decision);
      else if (action==='resolve' && id && decision && operator && session) journal.resolve(id,decision,operator,session);
      else if (action==='resolve-worker' && id && decision && operator) journal.resolveWorker(id,decision,operator);
      else throw new Error('Expected review list, review resolve DELIVERY acked|abandon|requeue OPERATOR resume|unused, or review resolve-worker DELIVERY complete|abandon OPERATOR');
    } finally { journal.db.close(); }
    return;
  }
  if (cmd) throw new Error('Unknown service command');
  await requireOwnerLock(join(state,'owner.lock'));
  const secret = (await readFile(required('JAM_WEBHOOK_SECRET_FILE'),'utf8')).trim();
  if (!secret) throw new Error('Missing signing secret');
  const routes = await openTopics(state);
  const server = webhook(routes,secret);
  await new Promise<void>((ok,fail) => { server.once('error',fail); server.listen(19739,'0.0.0.0',ok); });
  const stop = new AbortController();
  function shutdown() { stop.abort(); server.close(); server.closeAllConnections(); }
  process.once('SIGTERM',shutdown);
  process.once('SIGINT',shutdown);
  console.log('Signed issue intake ready for',routes.size,'repositories');
  const tasks = [...routes.values()].map(route=>consume(route,stop.signal));
  try { await Promise.all(tasks); }
  finally {
    shutdown();
    await Promise.allSettled(tasks);
    for (const route of routes.values()) route.journal.db.close();
  }
}
main().catch(err => { console.error(err.message); process.exitCode=1; });
