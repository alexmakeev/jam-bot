import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { topicKey, type TopicRuntime } from './topics.js';
import { isWorkerAcceptanceCard } from './approved-worker.js';

type Routes = ReadonlyMap<string, TopicRuntime>;

const limit = 2 * 1024 * 1024;
async function receive(req: IncomingMessage, res: ServerResponse, routes: Routes, secret: string) {
  const end = (status: number, data?: string) => { res.writeHead(status); res.end(data); };
  if (req.method === 'GET' && req.url === '/health') {
    for (const {journal} of routes.values()) journal.db.prepare('SELECT 1').get();
    return end(200,'ready\n');
  }
  if (req.method !== 'POST' || req.url !== '/github') return end(404);
  const sig = req.headers['x-hub-signature-256'];
  if (typeof sig !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(sig)) return end(403);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({destroyOnReturn:false})) {
    size += chunk.length;
    if (size > limit) { res.setHeader('Connection','close'); return end(413); }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const expected = createHmac('sha256',secret).update(bytes).digest();
  if (!timingSafeEqual(expected,Buffer.from(sig.slice(7),'hex'))) return end(403);
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { return end(400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return end(400);
  const type = req.headers['x-github-event'];
  if (type !== 'issues' || !['opened','locked'].includes(data.action)) return end(204);
  const repoId = data.repository?.id;
  const installation = data.installation?.id;
  if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(installation)) return end(403);
  const route = routes.get(topicKey(installation,repoId));
  if (!route || data.repository.full_name !== route.topic.repository) return end(403);
  const { journal } = route;
  const delivery = req.headers['x-github-delivery'];
  const issue = data.issue;
  // This installation handles personal repositories. Organization intake requires
  // a live effective-role lookup and stays closed until that adapter is configured.
  if (!issue || typeof issue !== 'object') return end(400);
  const owner = data.repository.owner;
  const actor = data.sender;
  if (owner?.type !== 'User' || !Number.isSafeInteger(owner.id) || owner.id <= 0 ||
      actor?.type !== 'User' || actor.id !== owner.id ||
      issue?.user?.type !== 'User' || issue.user.id !== actor.id) return end(204);
  if (typeof delivery !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(delivery) ||
      !Number.isSafeInteger(issue?.number) || issue.number <= 0 || typeof issue.title !== 'string' ||
      !(issue.body == null || typeof issue.body === 'string')) return end(400);
  if (data.action === 'locked' && (issue.locked !== true || typeof actor.login !== 'string' ||
      !/^[a-zA-Z0-9-]+$/.test(actor.login) || typeof issue.body !== 'string' ||
      !isWorkerAcceptanceCard(issue.body))) return end(204);
  journal.enqueue({ delivery, issue:issue.number, action:data.action, actorId:actor.id, actorLogin:actor.login,
    title:issue.title.slice(0,512), body:(issue.body ?? '').slice(0,8192) });
  return end(202);
}
export function webhook(routes: Routes, secret: string) {
  return createServer({ requestTimeout:30_000, headersTimeout:15_000, maxHeaderSize:16384 }, (req,res) => {
    receive(req,res,routes,secret).catch(() => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
  });
}
