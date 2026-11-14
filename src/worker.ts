import { createServer } from 'node:net';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Assignment, Checkpoint, Config } from './model.js';
import { atomicJson, checkpointPath, FixtureSource, key, readJson } from './storage.js';
import { admit } from './coordinator.js';
import { git } from './git.js';
const config = JSON.parse(process.argv[2]!) as Config;
const a = JSON.parse(process.argv[3]!) as Assignment;
const source = new FixtureSource(config.root);
const server = createServer(socket => socket.end(a.token + '\n'));
let attempt = 0;
async function fence(): Promise<void> {
  const owner = await source.readOwner(a.card.projectUri);
  const card = await source.readCard(a.id); admit(card, config);
  if (owner.server !== config.server || owner.epoch !== a.owner.epoch || card.scope !== a.card.scope)
    throw new Error('Ownership/approval changed; fenced');
}
async function checkpoint(completed: string[], outcome: Checkpoint['outcome']): Promise<void> {
  await fence();
  await atomicJson(checkpointPath(config.root, a.id), {
    phase: outcome === 'completed' ? 'in-validation' : 'in-progress', completed,
    revision: await git(a.worktree, 'rev-parse', 'HEAD'), attempt, outcome, workerPid: process.pid,
    summary: `Observed real worktree artifacts: ${completed.join(', ') || 'none'}`
  } satisfies Checkpoint);
}
server.on('error', (e: NodeJS.ErrnoException) => {
  process.send?.({ status: 'error', error: e.code === 'EADDRINUSE' ? 'Execution endpoint occupied; inspect, do not duplicate' : String(e) });
  process.exitCode = 1;
});
server.listen({ host: '127.0.0.1', port: a.port, exclusive: true }, () => {
  void execute().catch(async error => {
    await appendFile(join(config.root, 'diagnostics.log'), `${a.id}: ${String(error)}\n`);
    server.close(); process.exitCode = 1;
  });
});
async function execute(): Promise<void> {
  await fence();
  let prior: Checkpoint | undefined;
  try { prior = await readJson(checkpointPath(config.root, a.id)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  attempt = (prior?.attempt ?? 0) + 1;
  await mkdir(join(a.worktree, 'fixture'), { recursive: true });
  // All agents inspect guidance on startup/recovery. Its absence is allowed for initial work.
  try { await readFile(join(a.worktree, '.jam-bot', 'VALUES.md'), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const completed: string[] = [];
  const effects = ['first', 'second'];
  for (const step of effects) {
    const file = join(a.worktree, 'fixture', `${step}.txt`);
    try {
      if (await readFile(file, 'utf8') !== `${a.id}:${step}\n`) throw new Error(`Conflicting real code at ${file}`);
      completed.push(step);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  await checkpoint(completed, 'running');
  process.send?.({ status: 'started' });
  // A parent restart is harmless: child keeps the OS execution endpoint until exit.
  for (const step of effects) {
    if (completed.includes(step)) continue;
    await delay(config.stepDelayMs ?? 100);
    await fence();
    const file = join(a.worktree, 'fixture', `${step}.txt`);
    // Effect is inspectable: recovery skips it even if killed before checkpoint publication.
    await appendFile(file, `${a.id}:${step}\n`);
    completed.push(step);
    await checkpoint(completed, 'running');
  }
  await checkpoint(completed, 'completed');
  server.close();
}
