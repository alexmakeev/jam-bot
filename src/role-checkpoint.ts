import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {observe,roleRefused} from './review-supervisor.js';
import {atomicJson,readJson} from './storage.js';
import {runRoleStage,type RoleStage} from './role-harness.js';
import {fingerprint,recordProgress} from './work-progress.js';
import {reportedRuntimeBlocker,RoleStageFailure,roleStageFailure,type RoleFailureCategory} from './role-failure.js';

type Receipt=Awaited<ReturnType<typeof runRoleStage>>;
type Nonce=ReturnType<typeof randomUUID>;
interface Checkpoint {version?:2;session:string;input:string;challenge:Nonce;startedAt:number;completedAt?:number;attempt:number;workspaceManifest?:string;receipt?:Receipt;failure?:string;failureCategory?:RoleFailureCategory;failureDetail?:string}

export async function checkpointRole(job:RoleStage,next:string,run=runRoleStage,recover=observe,emitResult=true){
  const digest=fingerprint(job.workspaceManifest?JSON.stringify([job.input,job.workspaceManifest]):job.input);
  const id=job.role+'-'+digest;
  const roles=join(job.state,'assignments',String(job.issue),'roles');
  for(const name of (await readdir(roles).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;return [];})).filter(name=>name.startsWith(job.role+'-')&&name.endsWith('.json'))){
    const previousPath=join(roles,name);
    const previous=await readJson<Checkpoint>(previousPath);
    if(previous.failure){
      const detail=previous.failureDetail??previous.failure;
      const category=previous.failureCategory??roleStageFailure(job.role,detail).category;
      if(category==='harness_refusal')throw new RoleStageFailure(job.role,category,detail);
    }
    if(name===id+'.json'||previous.failure)continue;
    let priorReceipt=previous.receipt;
    if(!priorReceipt){
      const original={...job,input:previous.input,session:previous.session,workspaceManifest:previous.workspaceManifest};
      let observed;
      try{observed=await recover(original,previous);}catch(error){
        const failure=roleStageFailure(job.role,error);
        if(failure.category==='harness_refusal'){previous.failure=failure.message;previous.failureCategory=failure.category;previous.failureDetail=failure.localDetail;await atomicJson(previousPath,previous);}
        throw failure;
      }
      if(observed.refused){
        const failure=roleStageFailure(job.role,'The original role invocation refused before its failure checkpoint was saved');
        previous.failure=failure.message;previous.failureCategory=failure.category;previous.failureDetail=failure.localDetail;await atomicJson(previousPath,previous);throw failure;
      }
      priorReceipt=observed.receipt;
      if(!priorReceipt)throw roleStageFailure(job.role,'A different unfinished role input requires reconciliation before another dispatch');
    }
    const priorBlocker=reportedRuntimeBlocker(job.role,priorReceipt.output);
    if(priorBlocker){
      previous.failure=priorBlocker.message;previous.failureCategory=priorBlocker.category;previous.failureDetail=priorBlocker.localDetail;
      await atomicJson(previousPath,previous);throw priorBlocker;
    }
    if(!previous.receipt)await atomicJson(previousPath,{...previous,completedAt:Date.now(),receipt:priorReceipt});
  }
  const path=join(job.state,'assignments',String(job.issue),'roles',id+'.json');
  const saved=await readJson<Checkpoint>(path).catch((err:NodeJS.ErrnoException)=>{if(err.code!=='ENOENT')throw err;});
  if(saved && (saved.session!==job.session || saved.input!==job.input))throw Error('Role checkpoint differs from active assignment');
  const checkpoint:Checkpoint=saved??{version:2,session:job.session,input:job.input,challenge:randomUUID(),startedAt:Date.now(),attempt:1,...(job.workspaceManifest?{workspaceManifest:job.workspaceManifest}:{})};
  if(checkpoint.failure){
    const failure=roleStageFailure(job.role,checkpoint.failureDetail??checkpoint.failure);
    throw new RoleStageFailure(job.role,checkpoint.failureCategory??failure.category,failure.localDetail);
  }
  if(!saved)await atomicJson(path,checkpoint);
  const version=digest.slice(0,12);
  let receipt=checkpoint.receipt;
  let reconcile=Boolean(saved);
  while(!receipt){
    job.signal.throwIfAborted();
    let name=job.role+'-'+job.issue+'-'+checkpoint.challenge.slice(0,6);
    if(reconcile){
      const observed=await recover(job,checkpoint);
      if(observed.refused){
        const failure=roleStageFailure(job.role,'Original '+job.role+' refused '+name+'; architect diagnosis is required');
        checkpoint.failure=failure.message;checkpoint.failureCategory=failure.category;checkpoint.failureDetail=failure.localDetail;
        await atomicJson(path,checkpoint);throw failure;
      }
      if(observed.receipt){receipt=observed.receipt;break;}
      if(observed.live){
        const minutes=Number(process.env.JAM_NATIVE_STAGE_TIMEOUT_MINUTES??15);
        if(Date.now()-checkpoint.startedAt>minutes*60000+30000)throw roleStageFailure(job.role,'Original '+job.role+' may still be active; reconcile '+name);
        await delay(1000,undefined,{signal:job.signal});continue;
      }
      if(checkpoint.attempt>=2)throw roleStageFailure(job.role,'No verified '+job.role+' result after bounded recovery');
      checkpoint.attempt++;checkpoint.startedAt=Date.now();checkpoint.challenge=randomUUID();
      await atomicJson(path,checkpoint);
      name=job.role+'-'+job.issue+'-'+checkpoint.challenge.slice(0,6);
      recordProgress(job.state,job.issue,id+'-retry','JAM recovered incomplete '+job.role+' input `'+version+'`. The previous process ended without a verified response. Replacement '+name+' will resume it.');
      reconcile=false;
    }
    recordProgress(job.state,job.issue,id+'-assigned-'+checkpoint.attempt,'JAM assigned '+job.role+' ('+name+') input `'+version+'`. Awaiting the native teammate’s response.');
    try{receipt=await run(job,checkpoint.challenge);}
    catch(error){
      if(job.signal.aborted)throw error;
      if(error instanceof Error && /receipt timed out|runtime exited before verified receipt/.test(error.message)){reconcile=true;continue;}
      const failure=roleStageFailure(job.role,error);
      checkpoint.failure=failure.message;checkpoint.failureCategory=failure.category;checkpoint.failureDetail=failure.localDetail;
      await atomicJson(path,checkpoint);throw failure;
    }
  }
  try{
    if(checkpoint.version===2)checkpoint.completedAt??=Date.now();
    if(await roleRefused(job,checkpoint))throw roleStageFailure(job.role,'The original native invocation refused; fallback receipts cannot authorize continuation');
    const blocker=reportedRuntimeBlocker(job.role,receipt.output);
    if(blocker)throw blocker;
  }catch(error){
    const failure=roleStageFailure(job.role,error);
    checkpoint.failure=failure.message;checkpoint.failureCategory=failure.category;checkpoint.failureDetail=failure.localDetail;
    await atomicJson(path,checkpoint);throw failure;
  }
  if(!checkpoint.receipt)await atomicJson(path,{...checkpoint,receipt});
  const identity=(checkpoint.version===2?id+'-'+checkpoint.challenge:id)+'-received';
  if(!checkpoint.version)await atomicJson(join(job.state,'assignments',String(job.issue),'handoffs',fingerprint(receipt.output)+'.json'),{identity,member:receipt.nativeMember,role:job.role});
  if(emitResult)recordProgress(job.state,job.issue,identity,job.role+' returned verified output `'+fingerprint(receipt.output).slice(0,12)+'` for input `'+version+'`. Next: '+next+'.',job.role==='designer'?{purpose:'design',markdown:receipt.output}:undefined);
  return {...receipt,...(checkpoint.version===2?{dispatchIdentity:identity}:{})};
}
