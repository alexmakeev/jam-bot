import { appReader } from './github-app.js';

export async function readLockedIssue(url: string): Promise<{ url: string; title: string; body: string }> {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)$/.exec(url);
  if (!match) throw new Error('Expected a GitHub issue URL');
  const [, owner, repo, number] = match;
  const read = await appReader(owner + '/' + repo);
  const issue = await read('repos/' + owner + '/' + repo + '/issues/' + number);
  if (issue.html_url !== url || issue.pull_request || issue.state !== 'open' || issue.locked !== true)
    throw new Error('Worker paused: expected the specified open issue with a locked conversation');
  return { url, title: issue.title, body: issue.body ?? '' };
}
