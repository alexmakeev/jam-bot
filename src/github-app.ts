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
async function appJwt() {
  const app = process.env.JAM_GITHUB_APP_ID;
  const keyPath = process.env.JAM_GITHUB_APP_KEY_FILE;
  if (!app || !keyPath || !/^\d+$/.test(app))
    throw new Error('GitHub App credentials must be configured');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = encode({ alg:'RS256',typ:'JWT' }) + '.' + encode({iat:now-60,exp:now+540,iss:app});
  const signature = createSign('RSA-SHA256').update(data).sign(await readFile(keyPath)).toString('base64url');
  return data+'.'+signature;
}

export async function installationToken(repository: string, installation: string | undefined, issues: 'read'|'write') {
  if (!installation || !/^\d+$/.test(installation)) throw new Error('Missing installation identity');
  const result = await request('app/installations/' + installation + '/access_tokens', await appJwt(),
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


export async function inspectProject(repository:string, installation:number) {
  const binding=await request('repos/'+repository+'/installation',await appJwt());
  if(binding.id!==installation || binding.suspended_at || binding.permissions?.issues!=='write')
    throw Error('The selected installation needs active Issues write access.');
  const read=await appReader(repository,String(installation));
  const repo=await read('repos/'+repository);
  return {repository: String(repo.full_name), repoId:Number(repo.id), installation};
}

// An owner may discover a new installation before this server has a topic for it.
export async function availableProjects(installation:number, page:number) {
  const jwt=await appJwt();
  const binding=await request('app/installations/'+installation,jwt);
  if(binding.suspended_at) throw Error('Installation is suspended');
  const grant=await request('app/installations/'+installation+'/access_tokens',jwt,'POST',{permissions:{metadata:'read'}});
  const result=await request('installation/repositories?per_page=100&page='+page,grant.token);
  return {total:Number(result.total_count),projects:result.repositories.map((r:{id:number;full_name:string})=>({
    repoId:r.id,sourceUri:'https://github.com/'+r.full_name
  }))};
}

export async function availableInstallations(page:number) {
  const result=await request('app/installations?per_page=100&page='+page,await appJwt());
  return result.map((i:{id:number;account:{login:string};suspended_at:string|null})=>({
    installationId:i.id,account:i.account.login,suspended:Boolean(i.suspended_at)
  }));
}
