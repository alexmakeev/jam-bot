import { mkdir, readdir, readFile, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Journal, type Topic } from './intake-journal.js';
import { notifyLeo } from './leo-intake.js';
import { webhook } from './webhook.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Missing '+name);
  return value;
}
function numericId(name: string) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value<=0) throw new Error('Invalid '+name);
  return value;
}
async function requireOwnerLock(path: string) {
  for (const fd of await readdir('/proc/self/fd')) {
    const target = await readlink('/proc/self/fd/'+fd).catch(()=>null);
    if (target === path && /FLOCK\s+ADVISORY\s+WRITE/.test(await readFile('/proc/self/fdinfo/'+fd,'utf8'))) return;
  }
  throw new Error('Start the service under flock -n -F '+path);
}
async function main() {
  const state = resolve(required('JAM_STATE_DIR'));
  const [cmd,action,id,decision,operator,session] = process.argv.slice(2);
  if (cmd === 'review') {
    const journal = new Journal(join(state,'intake.sqlite'));
    try {
      if (action==='list') console.log(JSON.stringify({session:journal.lead(), deliveries:journal.list()},null,2));
      else if (action==='resolve' && id && decision && operator && session) journal.resolve(id,decision,operator,session);
      else throw new Error('Expected review list or review resolve DELIVERY acked|abandon|requeue OPERATOR resume|unused');
    } finally { journal.db.close(); }
    return;
  }
  if (cmd) throw new Error('Unknown service command');
  await requireOwnerLock(join(state,'owner.lock'));
  const cwd = join(state,'leo');
  await mkdir(cwd,{recursive:true,mode:0o700});
  const topic: Topic = { repoId:numericId('JAM_REPOSITORY_ID'), installation:numericId('JAM_INSTALLATION_ID'), repository:required('JAM_REPOSITORY'), cwd };
  const secret = (await readFile(required('JAM_WEBHOOK_SECRET_FILE'),'utf8')).trim();
  if (!secret) throw new Error('Missing signing secret');
  const journal = new Journal(join(state,'intake.sqlite'));
  journal.start(topic);
  const server = webhook(topic,secret,journal);
  await new Promise<void>((ok,fail) => { server.once('error',fail); server.listen(19739,'0.0.0.0',ok); });
  const stop = new AbortController();
  function shutdown() { stop.abort(); server.close(); server.closeAllConnections(); }
  process.once('SIGTERM',shutdown);
  process.once('SIGINT',shutdown);
  console.log('Signed issue intake ready');
  try {
    while (!stop.signal.aborted) {
      const event = journal.next();
      if (!event) { await delay(500); continue; }
      try {
        const ack = await notifyLeo(event,journal.lead(),cwd,topic.repository,stop.signal);
        journal.complete(ack);
        console.log('Leo acknowledged issue', event.issue);
      } catch (error) {
        journal.fail(event.delivery,error instanceof Error ? error.message : 'Dispatch failed');
        console.error('Leo intake requires review for issue',event.issue);
      }
    }
  } finally { shutdown(); journal.db.close(); }
}
main().catch(err => { console.error(err.message); process.exitCode=1; });
