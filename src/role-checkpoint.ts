import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {observe} from './review-supervisor.js';
import {atomicJson,readJson} from './storage.js';
import {runRoleStage,type RoleStage} from './role-harness.js';
import {fingerprint,recordProgress} from './work-progress.js';
import {RoleStageFailure,roleStageFailure,type RoleFailureCategory} from './role-failure.js';

type Receipt=Awaited<ReturnType<typeof runRoleStage>>;
type Nonce=ReturnType<typeof randomUUID>;
interface Checkpoint {session:string;input:string;challenge:Nonce;startedAt:number;attempt:number;receipt?:Receipt;failure?:string;failureCategory?:RoleFailureCategory;failureDetail?:string}

export async function checkpointRole(job:RoleStage,next:string,run=runRoleStage,recover=observe,emitResult=true){
  const digest=fingerprint(job.input);
  const id=job.role+'-'+digest;
  const path=join(job.state,'assignments',String(job.issue),'roles',id+'.json');
  const saved=await readJson<Checkpoint>(path).catch((err:NodeJS.ErrnoException)=>{if(err.code!=='ENOENT')throw err;});
  if(saved && (saved.session!==job.session || saved.input!==job.input))throw Error('Role checkpoint differs from active assignment');
  const checkpoint:Checkpoint=saved??{session:job.session,input:job.input,challenge:randomUUID(),startedAt:Date.now(),attempt:1};
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
  if(!checkpoint.receipt)await atomicJson(path,{...checkpoint,receipt});
  await atomicJson(join(job.state,'assignments',String(job.issue),'handoffs',fingerprint(receipt.output)+'.json'),{identity:id+'-received',member:receipt.nativeMember,role:job.role});
  if(emitResult)recordProgress(job.state,job.issue,id+'-received',job.role+' returned verified output `'+fingerprint(receipt.output).slice(0,12)+'` for input `'+version+'`. Next: '+next+'.',job.role==='designer'?{purpose:'design',markdown:receipt.output}:undefined);
  return receipt;
}
