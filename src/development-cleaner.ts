import {lstat,readdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {git} from './profile-checkout.js';
import {atomicJson,readJson,createJson} from './storage.js';
import {cleanOwnedResource,type CleanupResourceReceipt} from './development-cleanup-resource.js';
import {diskStatus} from './management-diagnostics.js';

interface CleanupInput {state:string;issue:number;head:string;dev:string;store:string;tree:string;branch:string}
async function size(path:string):Promise<bigint>{
  let count=0,total=0n;const seen=new Set<string>();
  const visit=async(path:string):Promise<void>=>{
    if(++count>200000)throw Error('Cleanup size inventory exceeded the bounded file budget');
    const info=await lstat(path,{bigint:true});
    if(info.isDirectory()){for(const name of await readdir(path))await visit(join(path,name));}
    else if(!info.isSymbolicLink()){
      const identity=info.dev+':'+info.ino;if(!seen.has(identity)){seen.add(identity);total+=info.size;}
    }
  };await visit(path);return total;
}
export async function cleanDevelopmentTask(input:CleanupInput,afterDelete?:(path:string)=>Promise<void>){
  const {state,issue,head,dev,store,tree,branch}=input;
  if(!Number.isSafeInteger(issue)||issue<1||!new RegExp('^[a-f0-9]{40}$').test(head)||!/^[a-f0-9]{40}$/.test(dev)||store!==join(state,'project.git')||tree!==join(state,'worktrees',String(issue))||branch!=='jam/issue-'+issue)throw Error('Cleanup resource ownership differs from Development policy');
  const closed=await readJson<{issue:number;head:string;dev:string}>(join(state,'assignments',String(issue),'closed.json'));
  if(closed.issue!==issue||closed.head!==head||closed.dev!==dev)throw Error('Cleanup requires the verified issue closure for this integrated head');
  const path=join(state,'assignments',String(issue),'cleanup.json');
  const saved=await readJson<{head:string;dev:string;completedAt?:string;summary?:string;markdown?:string;removedLogicalBytes?:string}>(path).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;return undefined;});
  if(saved&&(saved.head!==head||saved.dev!==dev))throw Error('Cleanup intent belongs to another integrated result');
  if(saved?.completedAt&&saved.markdown)return saved;
  const proposedBefore=await diskStatus(state);
  const proposedPlan={version:1,profile:'Development',issue,head,dev,startedAt:new Date().toISOString(),before:proposedBefore,resources:[{path:'worktrees/'+issue,kind:'task worktree',reason:'Exact task head integrated into dev and issue closure confirmed'},{path:'refs/heads/'+branch,kind:'task branch',reason:'Integrated task branch no longer needed after closure'}],retained:['assignments/'+issue+' (specifications, reports and recovery evidence)','workspace-snapshots (may be shared by other tasks)','shared build caches, images, credentials and rollback resources (no exclusive task ownership)']};
  const intent=join(state,'assignments',String(issue),'cleanup-intent.json');
  await createJson(intent,proposedPlan);const plan=await readJson<typeof proposedPlan>(intent);
  if(plan.issue!==issue||plan.head!==head||plan.dev!==dev)throw Error('Original cleanup plan differs from integrated task');
  await createJson(path,plan);
  const outcomes:CleanupResourceReceipt[]=[];
  outcomes.push(await cleanOwnedResource({receipt:join(state,'assignments',String(issue),'cleanup-worktree.json'),path:'worktrees/'+issue,
    exists:()=>lstat(tree).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;}),
    measureAndVerify:async()=>{
      const info=await lstat(tree);
      if(info.isSymbolicLink()||await realpath(tree)!==tree||await git(tree,'status','--porcelain')||await git(tree,'rev-parse','HEAD')!==head||await git(tree,'branch','--show-current')!==branch)throw Error('Task worktree is dirty, redirected or no longer at its integrated head');
      return size(tree);
    },remove:()=>git(store,'worktree','remove',tree).then(()=>{}),afterDelete}));
  outcomes.push(await cleanOwnedResource({receipt:join(state,'assignments',String(issue),'cleanup-branch.json'),path:'refs/heads/'+branch,
    exists:async()=>Boolean(await git(store,'branch','--list',branch)),measureAndVerify:async()=>{
      const linked=(await git(store,'worktree','list','--porcelain')).split('\n\n').filter(block=>block.split('\n').includes('branch refs/heads/'+branch));
      if(linked.length||await git(store,'rev-parse','refs/heads/'+branch)!==head)throw Error('Task branch remains attached or changed; retained');return 0n;
    },remove:()=>git(store,'update-ref','-d','refs/heads/'+branch,head).then(()=>{}),afterDelete}));
  const removedBytes=outcomes.filter(outcome=>outcome.status==='removed').reduce((total,outcome)=>total+BigInt(outcome.bytes??'0'),0n);
  const uncertainBytes=outcomes.filter(outcome=>outcome.status==='reconciled-absent').reduce((total,outcome)=>total+BigInt(outcome.bytes??'0'),0n);
  const before=plan.before;
  const after=await diskStatus(state),delta=BigInt(after.freeBytes)-BigInt(before.freeBytes);
  const icon={green:'🟢',yellow:'🟡',orange:'🟠',red:'🔴'}[after.status]!;
  const summary='Cleanup '+(outcomes.some(o=>o.status==='retained')?'completed with retained resources':'completed')+'. Removed '+(Number(removedBytes)/1024**3).toFixed(3)+' GiB of measured file content.'+(uncertainBytes?' Another '+(Number(uncertainBytes)/1024**3).toFixed(3)+' GiB was inventoried before an interrupted removal; attribution remains uncertain.':'')+' Disk '+icon+' '+after.usedPercent.toFixed(1)+'% used; '+(Number(after.freeBytes)/1024**3).toFixed(1)+' GiB available.';
  const markdown='# JAM Cleaner report\n\n'+summary+'\n\nIntegrated revision: `'+dev+'`\n\n## Deletion manifest\n\n'+plan.resources.map(r=>'- `'+r.path+'`: '+r.reason+'.').join('\n')+'\n\n## Confirmed outcomes\n\n'+outcomes.map(o=>'- `'+o.path+'`: '+o.status+(o.bytes?' ('+o.bytes+' logical bytes)':'')+(o.detail?' — '+o.detail:'')+'.').join('\n')+'\n\n## Retained\n\n'+plan.retained.map(p=>'- '+p).join('\n')+'\n\n## Measurement\n\nFile content size is the sum of regular-file logical sizes, deduplicated by device/inode; symlinks are not followed. It is not a claim of physically reclaimed space. Available filesystem space changed by '+delta+' bytes during cleanup; concurrent activity and shared storage can affect that observation.\n';
  const result={...plan,completedAt:new Date().toISOString(),after,outcomes,removedLogicalBytes:removedBytes.toString(),uncertainRemovalInventoryBytes:uncertainBytes.toString(),observedFreeSpaceDeltaBytes:delta.toString(),summary,markdown};
  await atomicJson(path,result);return result;
}

export async function cleanDevelopmentCandidate(state:string,batch:string,dev:string,entries:{issue:number;head:string}[],afterDelete?:(path:string)=>Promise<void>){
  if(!/^[a-f0-9-]{36}$/.test(batch)||!/^[a-f0-9]{40}$/.test(dev)||!entries.length)throw Error('Invalid Development batch cleanup identity');
  const dir=join(state,'integration',batch),tree=join(dir,'worktree'),path=join(dir,'cleanup.json');
  const saved=await readJson<{dev:string;completedAt?:string;markdown?:string}>(path).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;return undefined;});
  if(saved?.dev!==undefined&&saved.dev!==dev)throw Error('Batch cleanup revision changed');
  if(saved?.completedAt&&saved.markdown)return saved;
  for(const entry of entries){
    const closed=await readJson<{head:string;dev:string}>(join(state,'assignments',String(entry.issue),'closed.json'));
    if(closed.head!==entry.head||closed.dev!==dev)throw Error('Batch cleanup requires all member issue closures');
  }
  const proposedPlan={version:1,profile:'Development',batch,dev,issues:entries.map(e=>e.issue),resource:'integration/'+batch+'/worktree',reason:'All batch issues closed after verified dev integration',startedAt:new Date().toISOString(),before:await diskStatus(state)};
  const intent=join(dir,'cleanup-intent.json');await createJson(intent,proposedPlan);const plan=await readJson<typeof proposedPlan>(intent);
  if(plan.dev!==dev||JSON.stringify(plan.issues)!==JSON.stringify(entries.map(e=>e.issue)))throw Error('Original batch cleanup plan changed');
  await createJson(path,plan);
  const outcome=await cleanOwnedResource({receipt:join(dir,'cleanup-worktree.json'),path:plan.resource,
    exists:()=>lstat(tree).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;}),
    measureAndVerify:async()=>{if(await realpath(tree)!==tree||await git(tree,'status','--porcelain')||await git(tree,'rev-parse','HEAD')!==dev)throw Error('Candidate worktree changed; retained');return size(tree);},
    remove:()=>git(join(state,'project.git'),'worktree','remove',tree).then(()=>{}),afterDelete});
  const bytes=outcome.status==='removed'?BigInt(outcome.bytes??'0'):0n,status=outcome.status,before=plan.before;
  const after=await diskStatus(state);
  const markdown='## Shared integration candidate cleanup\n\nResource: `'+plan.resource+'`\n\nReason: '+plan.reason+'.\n\nOutcome: '+status+'. '+(outcome.detail??'')+' Measured confirmed removed logical bytes: '+bytes+'; pre-removal inventory: '+(outcome.bytes??'0')+'. This resource belongs to the whole batch and is counted once, not once per issue. The durable batch manifest is retained.\n\nFilesystem available bytes before: '+before.freeBytes+'; after: '+after.freeBytes+'.\n';
  const result={...plan,completedAt:new Date().toISOString(),after,status,outcome,removedLogicalBytes:bytes.toString(),uncertainRemovalInventoryBytes:outcome.status==='reconciled-absent'?outcome.bytes:'0',markdown};await atomicJson(path,result);return result;
}
