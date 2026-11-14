import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { Assignment, Card, Config } from './model.js';
import { assignmentPath, createJson, FixtureSource, key, readJson, checkpointPath } from './storage.js';
import { inspect, startFixture } from './harness.js';
import { git } from './git.js';
export function admit(card: Card, config: Config): void {
  if (card.kind !== 'task' || !card.approval || !config.approvers.includes(card.approval.actor)
    || !card.approval.conversation || card.approval.scope !== card.scope) throw new Error('Unapproved task or invalid attribution/scope');
  if (card.locked !== true) throw new Error('Work card discussion must be confirmed locked');
  if (card.dependencies.length) throw new Error('Waiting for dependencies');
}
export async function run(config: Config, id: string): Promise<{ status: string; assignment: Assignment }> {
  const source = new FixtureSource(config.root);
  const card = await source.readCard(id); admit(card, config);
  const owner = await source.readOwner(card.projectUri);
  if (owner.server !== config.server) throw new Error('Ownership conflict: refusing second/returning owner');
  const path = assignmentPath(config.root, id);
  const proposed: Assignment = {
    id, card, owner, worktree: join(config.root, 'trees', key(id)),
    port: 20000 + parseInt(key(config.root + id).slice(0, 6), 16) % 30000, token: randomUUID(), nativeHandle: `fixture:${key(config.root + id)}`
  };
  await createJson(path, proposed);
  const a = await readJson<Assignment>(path);
  if (a.owner.epoch !== owner.epoch || a.owner.server !== config.server || a.card.scope !== card.scope)
    throw new Error('Assignment/ownership changed; reconcile with human before resuming');
  const observed = await inspect(a);
  if (observed === 'active') return { status: 'active', assignment: a };
  if (observed === 'unknown') throw new Error('Worker observation uncertain; no launch');
  // The fixture is prepared before concurrent supervisor starts. Git itself rejects conflicting worktree mutations.
  try { await git(a.worktree, 'rev-parse', '--show-toplevel'); }
  catch {
    await mkdir(join(config.root, 'trees'), { recursive: true });
    try { await git(config.repo, 'worktree', 'add', '-b', `jam-fixture-${key(id)}`, a.worktree, 'HEAD'); }
    catch (e) { throw new Error(`Worktree preparation uncertain; reconcile before retry: ${String(e)}`); }
  }
  try {
    const cp = await readJson<import('./model.js').Checkpoint>(checkpointPath(config.root, id));
    if (cp.outcome === 'completed' && (await Promise.all(['first', 'second'].map(step => readFile(join(a.worktree, 'fixture', step + '.txt'), 'utf8')))).every((text, i) => text === id + ':' + ['first','second'][i] + '\n'))
      return { status: 'completed', assignment: a };
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const status = await startFixture(config, a);
  return { status, assignment: a };
}
