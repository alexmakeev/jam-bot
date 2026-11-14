import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';

export class GitHubRequestError extends Error {
  constructor(readonly status: number) { super('GitHub App request failed: HTTP ' + status); }
}

async function request(path: string, token: string, method = 'GET', body?: object): Promise<any> {
  const response = await fetch('https://api.github.com/' + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new GitHubRequestError(response.status);
  if (response.status === 204) return;
  return response.json();
}
export async function installationToken(repository: string, installation: string | undefined, issues: 'read'|'write') {
  const app = process.env.JAM_GITHUB_APP_ID;
  const keyPath = process.env.JAM_GITHUB_APP_KEY_FILE;
  if (!app || !installation || !keyPath || !/^\d+$/.test(app) || !/^\d+$/.test(installation))
    throw new Error('GitHub App credentials must be configured');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = encode({ alg:'RS256',typ:'JWT' }) + '.' + encode({iat:now-60,exp:now+540,iss:app});
  const signature = createSign('RSA-SHA256').update(data).sign(await readFile(keyPath)).toString('base64url');
  const result = await request('app/installations/' + installation + '/access_tokens', data+'.'+signature,
    'POST', {repositories:[repository.split('/')[1]],permissions:{metadata:'read',issues}});
  if (typeof result.token !== 'string') throw new Error('Missing GitHub installation token');
  return result.token as string;
}

export async function appReader(repository: string, installation = process.env.JAM_INSTALLATION_ID): Promise<(path: string) => Promise<any>> {
  const token = await installationToken(repository,installation,'read');
  return path => request(path,token);
}

export async function issueClient(repository: string, installation: number) {
  const token = await installationToken(repository,String(installation),'write');
  return (suffix: string, method?: string, body?: object) => request('repos/'+repository+suffix,token,method,body);
}
