// Operator-run acceptance experiment. Uses a real issue and spends Claude Code quota.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkpointAuthor } from './claude-evidence.js';
import { readLockedIssue } from './locked-issue.js';
import { github, authorizeGitHubIssue } from './github-authorization.js';
import { atomicJson } from './storage.js';

async function main(): Promise<void> {
  const [url, approval] = process.argv.slice(2);
  if (!url || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/.test(url)
      || approval !== '--approve-experiment' || !process.stdin.isTTY) {
    throw new Error('Run in a terminal: node dist/src/live-recovery.js ISSUE_URL --approve-experiment');
  }
  // The explicit experiment approval is attributable to the authenticated operator.
  const approver = github('user');
  await authorizeGitHubIssue(url, approver);
  const issue = await readLockedIssue(url);
  let delivery: string | undefined;
  const receiver = process.env.JAM_E2E_RECEIVER;
  if (receiver) {
    const number = Number(url.split('/').pop());
    const repository = url.split('/').slice(3, 5).join('/');
    const boundRepository = execFileSync('docker', ['exec', receiver, 'printenv', 'JAM_REPOSITORY'],
      { encoding: 'utf8', timeout: 15_000 }).trim();
    if (boundRepository !== repository) throw new Error('Receiver belongs to another repository');
    const deadline = Date.now() + 180_000;
    while (!delivery && Date.now() < deadline) {
      const result = execFileSync('docker', ['exec', receiver, 'node', 'dist/src/webhook-service.js',
        'review', 'list'], { encoding: 'utf8', timeout: 15_000 });
      const row = JSON.parse(result).deliveries.find((event: { issue: number }) => event.issue === number);
      if (row && ['review', 'abandoned'].includes(row.state)) throw new Error('Delivery needs operator review');
      if (row?.state === 'received') {
        const ack = JSON.parse(row.receipt);
        if (ack?.disposition !== 'intake_received' || ack.issue !== number || ack.delivery !== row.delivery)
          throw new Error('Invalid Leo receipt');
        delivery = row.delivery;
      } else await delay(2000);
    }
    if (!delivery) throw new Error('Timed out waiting for the signed delivery and Leo acknowledgment');
  }
  const root = await mkdtemp(join(tmpdir(), 'jam-live-'));
  const worktree = join(root, 'worktree');
  // Temporary clone keeps experimental branches and Claude writes out of the source checkout.
  execFileSync('gh', ['repo', 'clone', url.split('/').slice(3,5).join('/'), worktree]);
  const session = randomUUID();
  const assignment = { issue: url, title: issue.title, approver: {id:approver.id, login:approver.login}, delivery, session, worktree };
  await atomicJson(join(root, 'assignment.json'), assignment);
  const nonce = randomUUID();
  await mkdir(join(worktree, 'evidence'));
  console.log('Live run directory:', root);

  const projectKey = (await realpath(worktree)).replace(/[^a-zA-Z0-9-]/g, '-');
  const trace = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', projectKey, session);
  async function phase(previous?: string): Promise<string> {
    const resume = Boolean(previous);
    const checkpoint = resume ? 'second' : 'first';
    const expected = checkpoint + '-' + nonce;
    const file = 'evidence/' + checkpoint + '.txt';
    const instruction = resume
      ? 'Resume the original in-process developer by its saved native agent ID ' + previous + '. Use SendMessage. Do not spawn a replacement. Ask it to read its first checkpoint and continue.'
      : 'Use the Agent tool to create exactly one native in-process teammate named developer. Assign it this checkpoint test.';
    const prompt = [
      'JAM-Bot operator-approved recovery experiment for ' + issue.url + '.',
      instruction, 'Have the developer itself write exactly ' + expected + ' to ' + file + ' via Write.',
      'The developer must send a checkpoint acknowledgment containing exactly the token ' + expected + ' to its lead and then wait. Do not write the checkpoint as the lead.',
      'No other files, shell commands or network calls are needed.'
    ].join(' ');
    await authorizeGitHubIssue(issue.url, approver);
    const current = await readLockedIssue(issue.url);
    if (current.body !== issue.body || current.title !== issue.title)
      throw new Error('The issue changed before dispatch');
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
        if (content?.trim() === expected) {
          const id = await checkpointAuthor(trace, expected, checkpoint + '.txt', previous);
          if (id) return id;
        }
        await delay(300);
      }
      throw new Error('Timed out waiting for ' + file);
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  }
  const nativeHandle = await phase();
  await atomicJson(join(root, 'assignment.json'), { ...assignment, nativeHandle });
  await phase(nativeHandle);
  await atomicJson(join(root, 'result.json'), { ...assignment, nativeHandle, checkpoints: ['first', 'second'] });
  console.log('Observed both checkpoints across a forced lead restart. Verified a single developer wrote and acknowledged both checkpoints.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
