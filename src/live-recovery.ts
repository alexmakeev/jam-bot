// Operator-run acceptance experiment. Uses a real issue and spends Claude Code quota.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from './storage.js';

async function main(): Promise<void> {
  const [url, approval] = process.argv.slice(2);
  if (!url || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/.test(url)
      || approval !== '--approve-experiment' || !process.stdin.isTTY) {
    throw new Error('Run in a terminal: node dist/src/live-recovery.js ISSUE_URL --approve-experiment');
  }
  const readIssue = () => JSON.parse(execFileSync('gh', ['issue', 'view', url,
    '--json', 'url,title,state,body'], { encoding: 'utf8' })) as
    { url: string; state: string; title: string; body: string };
  const issue = readIssue();
  if (issue.state !== 'OPEN' || issue.url !== url) throw new Error('Expected the specified open issue');
  const root = await mkdtemp(join(tmpdir(), 'jam-live-'));
  const worktree = join(root, 'worktree');
  // Temporary clone keeps experimental branches and Claude writes out of the source checkout.
  execFileSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', '.', worktree]);
  const session = randomUUID();
  const assignment = { issue: url, title: issue.title, session, worktree };
  await atomicJson(join(root, 'assignment.json'), assignment);
  const nonce = randomUUID();
  await mkdir(join(worktree, 'evidence'));
  console.log('Live run directory:', root);

  async function phase(resume: boolean): Promise<void> {
    const checkpoint = resume ? 'second' : 'first';
    const expected = checkpoint + '-' + nonce;
    const file = 'evidence/' + checkpoint + '.txt';
    const instruction = resume
      ? 'Resume the original in-process developer by its saved native agent ID from the original spawn result. Use SendMessage. Do not spawn a replacement. Ask it to read its first checkpoint and continue.'
      : 'Use the Agent tool to create exactly one native in-process teammate named developer. Assign it this checkpoint test.';
    const prompt = [
      'JAM-Bot operator-approved recovery experiment for ' + issue.url + '.',
      instruction, 'Have the developer itself write exactly ' + expected + ' to ' + file + ' via Write.',
      'The developer must send a checkpoint acknowledgment to its lead and then wait. Do not write the checkpoint as the lead.',
      'No other files, shell commands or network calls are needed.'
    ].join(' ');
    const child = spawn('claude', [resume ? '--resume' : '--session-id', session,
      '--teammate-mode', 'in-process', '--permission-mode', 'acceptEdits', '--strict-mcp-config', prompt],
      { cwd: worktree, stdio: 'inherit', env: { ...process.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } });
    let failure: Error | undefined;
    child.once('error', err => { failure = err; });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const deadline = Date.now() + 180_000;
    try {
      while (Date.now() < deadline) {
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode) throw new Error('Claude exited before checkpoint');
        let content: string | undefined;
        try { content = await readFile(join(worktree, file), 'utf8'); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
        if (content?.trim() === expected) return;
        await delay(300);
      }
      throw new Error('Timed out waiting for ' + file);
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  }
  await phase(false);
  const current = readIssue();
  if (current.state !== 'OPEN' || current.body !== issue.body || current.title !== issue.title)
    throw new Error('The issue changed during recovery');
  await phase(true);
  await atomicJson(join(root, 'result.json'), { ...assignment, checkpoints: ['first', 'second'] });
  console.log('Observed both checkpoints across a forced lead restart. Inspect the native tool trace for worker identity.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
