import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Journal, Topic } from './intake-journal.js';

const limit = 2 * 1024 * 1024;
async function receive(req: IncomingMessage, res: ServerResponse, topic: Topic, secret: string, journal: Journal) {
  const end = (status: number, data?: string) => { res.writeHead(status); res.end(data); };
  if (req.method === 'GET' && req.url === '/health') {
    journal.db.prepare('SELECT 1').get();
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
  if (type !== 'issues' || data.action !== 'opened') return end(204);
  if (data.installation?.id !== topic.installation || data.repository?.id !== topic.repoId ||
    data.repository?.full_name !== topic.repository) return end(403);
  const delivery = req.headers['x-github-delivery'];
  const issue = data.issue;
  if (typeof delivery !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(delivery) ||
      !Number.isSafeInteger(issue?.number) || issue.number <= 0 || typeof issue.title !== 'string' ||
      !(issue.body == null || typeof issue.body === 'string')) return end(400);
  journal.enqueue({ delivery, issue:issue.number, title:issue.title.slice(0,512), body:(issue.body ?? '').slice(0,8192) });
  return end(202);
}
export function webhook(topic: Topic, secret: string, journal: Journal) {
  return createServer({ requestTimeout:30_000, headersTimeout:15_000, maxHeaderSize:16384 }, (req,res) => {
    receive(req,res,topic,secret,journal).catch(() => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
  });
}
