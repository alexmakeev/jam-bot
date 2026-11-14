import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { git } from './git.js';
import { run } from './coordinator.js';
import { inspect } from './harness.js';
import { atomicJson, checkpointPath, key, readJson } from './storage.js';
import type { Card, Checkpoint, Config } from './model.js';
const root = await mkdtemp(join(tmpdir(), 'jam-demo-'));
const repo = join(root, 'repo'); await mkdir(repo);
await git(repo, 'init'); await git(repo, 'config', 'user.email', 'fixture@example.invalid'); await git(repo, 'config', 'user.name', 'Fixture');
await writeFile(join(repo, 'README.md'), 'Disposable recovery demonstration\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'fixture');
const card: Card = { id: 'demo', projectUri: 'fixture:demo', kind: 'task', locked: true, title: 'Recovery demo', scope: 'two fixture artifacts', dependencies: [], approval: { actor: 'fixture-owner', conversation: 'fixture:trusted/1', scope: 'two fixture artifacts' } };
const config: Config = { root, repo, server: 'local-demo', approvers: ['fixture-owner'], stepDelayMs: 600 };
await atomicJson(join(root, 'cards', key(card.id) + '.json'), card);
await atomicJson(join(root, 'owners', key(card.projectUri) + '.json'), { server: config.server, epoch: 'demo-1' });
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  throw new Error('Demo timed out; artifacts retained at ' + root);
}
const launched = await run(config, card.id);
await waitFor(async () => (await readJson<Checkpoint>(checkpointPath(root, card.id))).completed.length === 1);
const cp = await readJson<Checkpoint>(checkpointPath(root, card.id));
const replay = await run(config, card.id);
process.kill(cp.workerPid, 'SIGKILL');
await waitFor(async () => await inspect(launched.assignment) === 'absent');
const recovered = await run(config, card.id);
await waitFor(async () => (await readJson<Checkpoint>(checkpointPath(root, card.id))).outcome === 'completed');
const final = await readJson<Checkpoint>(checkpointPath(root, card.id));
console.log(JSON.stringify({ root, launched: launched.status, replay: replay.status, recovered: recovered.status, checkpoint: final, effects: await Promise.all(['first','second'].map(step => readFile(join(launched.assignment.worktree, 'fixture', step + '.txt'), 'utf8'))) }, null, 2));
