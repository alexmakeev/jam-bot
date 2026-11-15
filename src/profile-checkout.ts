import {atomicJson,readJson} from './storage.js';
import type {TaskApproval} from './task-approval.js';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, stat, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run=promisify(execFile);
export async function git(cwd:string,...args:string[]) {
  return (await run('git',['-c','core.hooksPath=/dev/null','-c','user.name=JAM-Bot','-c','user.email=jam-bot@localhost',...args],
    {cwd,timeout:30000,maxBuffer:2**20})).stdout.trimEnd();
}

export type ReviewPhase='architecture'|'implementation'|'diagnosis';
export interface ConsultationProgress {phase:ReviewPhase;updatedAt:string;providers:{name:string;provider:string;status:string;startedAt:string;updatedAt:string;finishedAt?:string}[]}
export interface Advice {name:string;provider:string;model?:string;startedAt?:string;finishedAt?:string;status:'ok'|'unavailable'|'error';text:string}
interface Request {repoId?:number;scope?:string;action:'project-profile'|'seed'|'test-head'|'test'|'publish'|'consult';phase?:ReviewPhase;packet?:string;only?:string[];repo:string;sha?:string;base?:string;expected?:string;cards?:{issue:number;approval:TaskApproval}[]}
export interface BrokerResult {sha:string;markdown?:string;owner?:string;advice?:Advice[];dev?:string;tests?:string[];log?:string;alreadyPublished?:boolean;awaitDeployment?:boolean}
export class PublisherSeedUnavailable extends Error {}

interface Reply {uncertain?:boolean;ok:boolean;error?:string;value?:BrokerResult}
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
const present=async(path:string)=>stat(path).then(()=>true,e=>{if(!missing(e))throw e;return false;});

function canonical(key:string,value:unknown):unknown {
  if(value && typeof value==='object' && !Array.isArray(value)){
    return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0));
  }
  return value;
}

async function promote(source:string,destination:string){
  try{await rename(source,destination);}
  catch(e){if(!['EEXIST','ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code??'') || !await present(destination))throw e;}
}

export async function exchange(repository:string, request:Request,signal:AbortSignal,onSlow?:(progress:ConsultationProgress)=>Promise<void>,onProgress?:(progress:ConsultationProgress)=>Promise<void>) {
  signal.throwIfAborted();
  const root=process.env.JAM_PROFILE_EXCHANGE ?? '/var/lib/jam-profile-exchange';
  // Unscoped seeds deliberately read current remote state during integration reconciliation.
  const durable=request.action!=='project-profile' && (request.action!=='seed' || Boolean(request.scope));
  const digest=createHash('sha256').update(JSON.stringify(request,canonical)).digest('hex');
  const id=durable?[digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20,32)].join('-'):randomUUID();
  const dir=join(root,id),stage=join(root,'.prepared-'+id);
  const ledger=join(dirname(repository),'broker-requests',digest);
  const receipt=join(ledger,'reply.json'),intent=join(ledger,'submitted.json');
  const value=(reply:Reply)=>{
    if(!reply.ok && request.action==='seed' && reply.error==='Repository outside publisher scope')throw new PublisherSeedUnavailable('Publisher is not configured for this repository');
    if(!reply.ok)throw Error('Profile broker: '+reply.error);
    if(!reply.value)throw Error('Missing profile broker reply');
    return reply.value;
  };
  const cached=async()=>durable?readJson<Reply>(receipt).catch(e=>{if(!missing(e))throw e;return undefined;}):undefined;
  const previous=await cached();
  if(previous)return value(previous);
  if(!await present(dir)){
    if(!await present(stage)){
      if(durable && await present(intent)){
        const done=await cached();if(done)return value(done);
        throw Error('Missing submitted profile broker request '+id+' requires reconciliation');
      }
      const temp=await mkdtemp(join(root,'.preparing-'));
      try{
        if(request.sha){
          const tmp=join(temp,'export');
          await git(temp,'init','--bare','export');
          await git(tmp,'fetch','--no-tags',repository,request.sha);
          await git(tmp,'update-ref','refs/heads/export',request.sha);
          await git(tmp,'bundle','create',join(temp,'candidate.bundle'),'refs/heads/export');
          await rm(tmp,{recursive:true});
        }
        await writeFile(join(temp,'request.ready'),JSON.stringify({...request,brokerRequestId:id}),{mode:0o600});
        await promote(temp,stage);
      }finally{await rm(temp,{recursive:true,force:true});}
    }
    if(durable)await atomicJson(intent,{id,digest,action:request.action});
    try{await promote(stage,dir);}
    catch(e){if(!missing(e)||!await present(dir))throw e;}
  }
  let received=false, retrySeed=false;
  try{
    const started=Date.now();
    let lastCheck=0,observedSlow=false,progressKey='';
    const until=started+(request.action==='consult'?35*60_000:240_000);
    while(Date.now()<until){
      signal.throwIfAborted();
      const reply=await readFile(join(dir,'answer.json'),'utf8').catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return '';});
      const slow=Boolean(onSlow) && !observedSlow && Date.now()-started>=90000 && Date.now()-lastCheck>=10000;
      if(onProgress || slow){
        const current=await readJson<ConsultationProgress>(join(dir,'progress.json')).catch(e=>{if(!missing(e))throw e;});
        if(current && current.phase===request.phase && Array.isArray(current.providers)){
          const key=JSON.stringify(current.providers.map(p=>[p.name,p.status]));
          if(onProgress && key!==progressKey){await onProgress(current);progressKey=key;}
          if(slow && !reply && current.providers.some(p=>p.status==='running')){
            lastCheck=Date.now();observedSlow=true;await onSlow!(current);
          }
        }
      }
      if(!reply){
        const done=await cached();if(done)return value(done);
        await delay(500,undefined,{signal});continue;
      }
      const result=JSON.parse(reply) as Reply;
      if(result.uncertain)throw Error('Profile broker request '+id+' requires reconciliation: '+(result.error??'unknown external result'));
      if(result.ok && request.action==='seed'){
        await git(repository,'fetch','--no-tags',join(dir,'seed.bundle'),'+refs/heads/seed:refs/remotes/profile/seed');
        // A scoped checkout must remain reachable even if later fresh seeds move the shared ref.
        if(durable && result.value?.sha)await git(repository,'update-ref','refs/jam-bot/seeds/'+digest,result.value.sha);
      }
      retrySeed=request.action==='seed' && !result.ok && result.error==='Repository outside publisher scope';
      if(durable && !retrySeed)await atomicJson(receipt,result);
      received=true;
      return value(result);
    }
    throw Error('Profile broker response requires reconciliation');
  }finally{
    if(received){
      if(durable && retrySeed)await rm(intent,{force:true});
      await rm(dir,{recursive:true,force:true});await rm(stage,{recursive:true,force:true});
    }
  }
}

export async function checkout(state:string,repo:string,issue:number,signal:AbortSignal){
  const store=join(state,'project.git');await mkdir(store,{recursive:true});await git(store,'init','--bare');
  const path=join(state,'assignments',String(issue),'checkout.json');
  let seed=await readJson<BrokerResult>(path).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
  if(!seed){seed=await exchange(store,{action:'seed',repo,scope:'issue:'+issue},signal);await atomicJson(path,seed);}
  const branch='jam/issue-'+issue;const tree=join(state,'worktrees',String(issue));
  await mkdir(join(state,'worktrees'),{recursive:true});
  const existing=await git(store,'branch','--list',branch);
  if(!existing)await git(store,'worktree','add','-b',branch,tree,seed.sha);
  else if(await git(tree,'branch','--show-current')!==branch || await git(tree,'rev-parse','HEAD')!==seed.sha || await git(tree,'status','--porcelain'))
    throw Error('Existing worktree conflicts with the recorded task checkout');
  return {store,tree,branch,base:seed.sha,expected:seed.dev ?? ''};
}
