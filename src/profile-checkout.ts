import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run=promisify(execFile);
export async function git(cwd:string,...args:string[]) {
  return (await run('git',['-c','core.hooksPath=/dev/null','-c','user.name=JAM-Bot','-c','user.email=jam-bot@localhost',...args],
    {cwd,timeout:30000,maxBuffer:2**20})).stdout.trimEnd();
}

interface Request {action:'seed'|'test-head'|'test'|'publish';repo:string;sha?:string;base?:string;expected?:string;cards?:{issue:number}[]}
export interface BrokerResult {sha:string;dev?:string;tests?:string[];log?:string;alreadyPublished?:boolean}
export async function exchange(repository:string, request:Request,signal:AbortSignal) {
  const dir=join(process.env.JAM_PROFILE_EXCHANGE ?? '/var/lib/jam-profile-exchange',randomUUID());
  await mkdir(dir,{mode:0o700});
  let received=false;
  try{
    if(request.sha){
      // Use a disposable bare repository so concurrent exports never share a mutable ref.
      await git(dir,'init','--bare','export'); const tmp=join(dir,'export');
      await git(tmp,'fetch','--no-tags',repository,request.sha);
      await git(tmp,'update-ref','refs/heads/export',request.sha);
      await git(tmp,'bundle','create',join(dir,'candidate.bundle'),'refs/heads/export');
    }
    await writeFile(join(dir,'request.tmp'),JSON.stringify(request),{mode:0o600});
    await rename(join(dir,'request.tmp'),join(dir,'request.ready'));
    const until=Date.now()+240000;
    while(Date.now()<until){
      signal.throwIfAborted();
      const reply=await readFile(join(dir,'answer.json'),'utf8').catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return '';});
      if(!reply){await delay(500,undefined,{signal});continue;}
      received=true;
      const result=JSON.parse(reply);
      if(!result.ok)throw Error('Profile broker: '+result.error);
      if(request.action==='seed')await git(repository,'fetch','--no-tags',join(dir,'seed.bundle'),'+refs/heads/seed:refs/remotes/profile/seed');
      return result.value as BrokerResult;
    }
    throw Error('Profile broker response requires reconciliation');
  }finally{if(received)await rm(dir,{recursive:true,force:true});}
}

export async function checkout(state:string,repo:string,issue:number,signal:AbortSignal){
  const store=join(state,'project.git');await mkdir(store,{recursive:true});await git(store,'init','--bare');
  const seed=await exchange(store,{action:'seed',repo},signal);
  const branch='jam/issue-'+issue;const tree=join(state,'worktrees',String(issue));
  await mkdir(join(state,'worktrees'),{recursive:true});
  await git(store,'worktree','add','-b',branch,tree,seed.sha);
  return {store,tree,branch,base:seed.sha,expected:seed.dev ?? ''};
}
