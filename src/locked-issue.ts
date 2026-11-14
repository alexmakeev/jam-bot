import { execFileSync } from 'node:child_process';

export function readLockedIssue(url: string): { url: string; title: string; body: string } {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)$/.exec(url);
  if (!match) throw new Error('Expected a GitHub issue URL');
  const [, owner, repo, number] = match;
  const raw = execFileSync('gh', ['api', '--hostname', 'github.com',
    `repos/${owner}/${repo}/issues/${number}`], { encoding: 'utf8', timeout: 15_000 });
  const issue = JSON.parse(raw);
  if (issue.html_url !== url || issue.pull_request || issue.state !== 'open' || issue.locked !== true)
    throw new Error('Worker paused: expected the specified open issue with a locked conversation');
  return { url, title: issue.title, body: issue.body ?? '' };
}
