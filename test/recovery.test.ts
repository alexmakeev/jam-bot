import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Card, Config, Checkpoint } from '../src/model.js';
import { atomicJson, checkpointPath, key, readJson } from '../src/storage.js';
import { run } from '../src/coordinator.js';
import { inspect } from '../src/harness.js';
import { git } from '../src/git.js';
const exec = promisify(execFile);
export async function fixture(): Promise<{ config: Config; card: Card; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'jam-recovery-'));
  const repo = join(root, 'repo'); await mkdir(repo);
  await git(repo, 'init'); await git(repo, 'config', 'user.email', 'fixture@example.invalid'); await git(repo, 'config', 'user.name', 'Fixture');
  await writeFile(join(repo, 'README.md'), 'Fixture only\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'fixture');
  const config: Config = { root, repo, server: 'server-a', approvers: ['owner'], stepDelayMs: 150 };
  const card: Card = { id: 'card-1', projectUri: 'fixture:repo', title: 'Approved fixture', scope: 'two inspectable effects', kind: 'task', locked: true, dependencies: [], approval: { actor: 'owner', conversation: 'fixture:trusted-conversation/1', scope: 'two inspectable effects' } };
  await atomicJson(join(root, 'cards', key(card.id) + '.json'), card);
  await atomicJson(join(root, 'owners', key(card.projectUri) + '.json'), { server: 'server-a', epoch: 'epoch-1' });
  return { config, card, cleanup: async () => { await delay(100); await rm(root, { recursive: true, force: true }); } };
}
export async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { try { const v = await read(); if (predicate(v)) return v; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } await delay(20); }
  throw new Error('Timed out waiting for evidence');
}
test('unapproved, report, changed scope and dependency cannot execute', async () => {
  const f = await fixture();
  try {
    for (const change of [{ approval: undefined }, { kind: 'report' }, { scope: 'different' }, { dependencies: ['not-ready'] }, { locked: false }, { locked: undefined }]) {
      await atomicJson(join(f.config.root, 'cards', key(f.card.id) + '.json'), { ...f.card, ...change });
      await assert.rejects(run(f.config, f.card.id), /Unapproved|dependencies|locked/);
    }
  } finally { await f.cleanup(); }
});
test('supervisor exit, worker SIGKILL, stale checkpoint and replay resume without duplicate effect', async () => {
  const f = await fixture(); f.config.stepDelayMs = 500;
  try {
    const cfg = join(f.config.root, 'config.json'); await atomicJson(cfg, f.config);
    const cli = new URL('../src/cli.js', import.meta.url).pathname;
    const first = JSON.parse((await exec(process.execPath, [cli, cfg, f.card.id])).stdout);
    assert.equal(first.status, 'started');
    const cp = await until(() => readJson<Checkpoint>(checkpointPath(f.config.root, f.card.id)), x => x.completed.length === 1);
    const second = JSON.parse((await exec(process.execPath, [cli, cfg, f.card.id])).stdout);
    assert.equal(second.status, 'active'); assert.equal(second.assignment.nativeHandle, first.assignment.nativeHandle);
    process.kill(cp.workerPid, 'SIGKILL');
    await until(() => inspect(first.assignment), x => x === 'absent');
    // Deliberately stale checkpoint: actual worktree must prevent repetition of the first effect.
    await atomicJson(checkpointPath(f.config.root, f.card.id), { ...cp, completed: [] });
    const recovered = await run(f.config, f.card.id); assert.equal(recovered.status, 'started');
    const final = await until(() => readJson<Checkpoint>(checkpointPath(f.config.root, f.card.id)), x => x.outcome === 'completed');
    assert.equal(final.attempt, 2); assert.deepEqual(final.completed, ['first', 'second']);
    for (const step of ['first','second']) assert.equal(await readFile(join(first.assignment.worktree, 'fixture', step + '.txt'), 'utf8'), `${f.card.id}:${step}\n`);
    await until(() => inspect(first.assignment), x => x === 'absent');
    assert.equal((await run(f.config, f.card.id)).status, 'completed');
  } finally { await f.cleanup(); }
});
test('simultaneous supervisors admit only one executor; conflicting/returning owner fails closed', async () => {
  const f = await fixture(); f.config.stepDelayMs = 500;
  try {
    const initial = await run(f.config, f.card.id);
    const results = await Promise.all([run(f.config, f.card.id), run(f.config, f.card.id)]);
    assert.deepEqual(results.map(x => x.status), ['active', 'active']);
    await assert.rejects(run({ ...f.config, server: 'server-b' }, f.card.id), /Ownership conflict/);
    await atomicJson(join(f.config.root, 'owners', key(f.card.projectUri) + '.json'), { server: 'server-b', epoch: 'epoch-2' });
    await assert.rejects(run(f.config, f.card.id), /Ownership conflict/);
    await until(() => inspect(initial.assignment), x => x === 'absent');
    assert.equal(await readFile(join(f.config.root, 'diagnostics.log'), 'utf8').then(x => x.includes('fenced')), true);
    // Returning old owner cannot use its old assignment even if the name is reintroduced.
    await atomicJson(join(f.config.root, 'owners', key(f.card.projectUri) + '.json'), { server: 'server-a', epoch: 'epoch-3' });
    await assert.rejects(run(f.config, f.card.id), /Assignment\/ownership changed/);
  } finally { await f.cleanup(); }
});
test('two cold starts share one OS execution endpoint and one attempt', async () => {
  const f = await fixture(); f.config.stepDelayMs = 400;
  try {
    // Prepare immutable assignment/worktree before deliberately racing launch requests.
    const { assignmentPath, createJson } = await import('../src/storage.js');
    const { randomUUID } = await import('node:crypto');
    const a = { id: f.card.id, card: f.card, owner: { server: 'server-a', epoch: 'epoch-1' }, worktree: join(f.config.root, 'tree'), port: 20000 + parseInt(key(f.config.root).slice(0,6),16) % 30000, token: randomUUID(), nativeHandle: 'fixture:cold' };
    await git(f.config.repo, 'worktree', 'add', '-b', 'cold-test', a.worktree, 'HEAD');
    await createJson(assignmentPath(f.config.root, f.card.id), a);
    const results = await Promise.allSettled([run(f.config, f.card.id), run(f.config, f.card.id)]);
    assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.status === 'started').length, 1);
    for (const r of results) if (r.status === 'rejected') assert.match(String(r.reason), /occupied/);
    const cp = await until(() => readJson<Checkpoint>(checkpointPath(f.config.root, f.card.id)), x => x.outcome === 'completed');
    assert.equal(cp.attempt, 1);
    for (const step of ['first','second']) assert.equal(await readFile(join(a.worktree, 'fixture', step + '.txt'), 'utf8'), `${f.card.id}:${step}\n`);
  } finally { await f.cleanup(); }
});
test('unknown listener never authorizes a replacement executor', async () => {
  const f = await fixture();
  const { createServer } = await import('node:net');
  const port = 20000 + parseInt(key(f.config.root + f.card.id).slice(0,6),16) % 30000;
  const listener = createServer(socket => socket.end('not-the-assignment-token\n'));
  await new Promise<void>(resolve => listener.listen(port, '127.0.0.1', resolve));
  try { await assert.rejects(run(f.config, f.card.id), /uncertain/); }
  finally { await new Promise<void>(resolve => listener.close(() => resolve())); await f.cleanup(); }
});
