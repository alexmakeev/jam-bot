import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {observe} from './review-supervisor.js';
import {atomicJson,readJson} from './storage.js';
import {runRoleStage,type RoleStage} from './role-harness.js';
import {fingerprint,recordProgress} from './work-progress.js';

type Receipt=Awaited<ReturnType<typeof runRoleStage>>;
type Nonce=ReturnType<typeof randomUUID>;
interface Checkpoint {session:string;input:string;challenge:Nonce;startedAt:number;attempt:number;receipt?:Receipt}

export async function checkpointRole(job:RoleStage,next:string,run=runRoleStage,recover=observe){
  const digest=fingerprint(job.input);
  const id=job.role+'-'+digest;
  const path=join(job.state,'assignments',String(job.issue),'roles',id+'.json');
  const saved=await readJson<Checkpoint>(path).catch((err:NodeJS.ErrnoException)=>{if(err.code!=='ENOENT')throw err;});
  if(saved && (saved.session!==job.session || saved.input!==job.input))throw Error('Role checkpoint differs from active assignment');
  const checkpoint=saved??{session:job.session,input:job.input,challenge:randomUUID(),startedAt:Date.now(),attempt:1};
  if(!saved)await atomicJson(path,checkpoint);
  const name=job.role+'-'+job.issue+'-'+checkpoint.challenge.slice(0,6);
  const version=digest.slice(0,12);
  recordProgress(job.state,job.issue,id+'-assigned','Leo assigned '+job.role+' ('+name+') input `'+version+'`. Awaiting the native teammate’s response.');
  let receipt=checkpoint.receipt;
  if(!receipt && saved){
    const observed=await recover(job,checkpoint);
    if(observed.refused || observed.live)throw Error('Original '+job.role+' refused or may still be active; reconcile '+name);
    receipt=observed.receipt;
    if(!receipt){
      if(checkpoint.attempt>=2)throw Error('No verified '+job.role+' result after bounded recovery');
      checkpoint.attempt++;checkpoint.startedAt=Date.now();checkpoint.challenge=randomUUID();
      await atomicJson(path,checkpoint);
      recordProgress(job.state,job.issue,id+'-retry','Leo recovered the incomplete '+job.role+' assignment for input `'+version+'`. The previous process ended without a verified response. One replacement will resume it.');
    }
  }
  receipt??=await run(job,checkpoint.challenge);
  if(!checkpoint.receipt)await atomicJson(path,{...checkpoint,receipt});
  recordProgress(job.state,job.issue,id+'-received',job.role+' returned verified output `'+fingerprint(receipt.output).slice(0,12)+'` for input `'+version+'`. Next: '+next+'.');
  return receipt;
}
