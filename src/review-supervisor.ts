import {recordProgress} from './work-progress.js';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {readdir,readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {atomicJson,readJson} from './storage.js';
import {mailboxReceipt,stageRefused} from './native-teammate.js';
import {runRoleStage,type RoleStage} from './role-harness.js';

export type ReviewRole='consultant'|'integrator';
type Challenge=ReturnType<typeof randomUUID>;
type Receipt=Awaited<ReturnType<typeof runRoleStage>>;
interface Attempt {challenge:Challenge;startedAt:number;endedAt?:number}
interface Checkpoint {session:string;issues:number[];revision:string;role:ReviewRole;input:string;attempts:Attempt[];receipt?:Receipt;failure?:string}
export interface MandatoryReview extends RoleStage {role:ReviewRole;issues:number[];revision:string}
const refusal='The native model refused the mandatory review';
const unavailable='The mandatory reviewer returned no verifiable result after bounded recovery';
const uncertain='The previous mandatory reviewer may still be active';

export async function observe(job:RoleStage,attempt:Attempt) {
  const config=process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude');
  const name=job.role+'-'+job.issue+'-'+attempt.challenge.slice(0,6);
  const transcript=join(config,'projects',job.cwd.replace(/[^a-zA-Z0-9-]/g,'-'),job.session+'.jsonl');
  if(await stageRefused(transcript,job.session,attempt.startedAt))return {refused:true};
  const receipt=await mailboxReceipt({config,cwd:job.cwd,session:job.session,name,challenge:attempt.challenge,agentType:'jam-'+job.role});
  if(receipt || attempt.endedAt)return {receipt};
  // A service restart can precede PTY teardown. Check identity before replacing this exact call.
  const pids=await readdir('/proc').catch(()=>undefined);
  if(!pids)return {live:true};
  for(const pid of pids.filter(p=>/^\d+$/.test(p))){
    const cmd=await readFile('/proc/'+pid+'/cmdline','utf8').catch((e:NodeJS.ErrnoException)=>{
      if(['ENOENT','ESRCH','EACCES','EPERM'].includes(e.code??''))return '';throw e;
    });
    if(cmd.includes(attempt.challenge)&&cmd.includes(name))return {live:true};
  }
  return {};
}

export async function mandatoryReview(job:MandatoryReview,escalate:(reason:string)=>Promise<void>,
  deps:{run:typeof runRoleStage;observe:typeof observe;pause:()=>Promise<void>;graceMs:number}={run:runRoleStage,observe,pause:()=>delay(1000,undefined,{signal:job.signal}),graceMs:30000}):Promise<Receipt> {
  if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(job.revision) || !job.issues.includes(job.issue) || job.issues.some(i=>!Number.isSafeInteger(i)||i<1))throw Error('Invalid mandatory review identity');
  const path=join(job.state,'mandatory-reviews',job.role+'-'+job.issues.join('-')+'-'+job.revision+'.json');
  let saved=await readJson<Checkpoint>(path).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
  saved??={session:job.session,revision:job.revision,issues:job.issues,role:job.role,input:job.input,attempts:[]};
  if(saved.session!==job.session)throw Error('Mandatory review lead identity changed');
  const checkpoint=saved;
  const stop=async(reason:string):Promise<never>=>{
    checkpoint.failure=reason;await atomicJson(path,checkpoint);
    for(const issue of job.issues)recordProgress(job.state,issue,'review-blocked:'+job.role+':'+job.revision,
      'Mandatory '+job.role+' review of `'+job.revision+'` is blocked. '+reason+'. LEO will deliver the evidence to the architect for diagnosis.');
    await escalate(reason);throw Error(reason);
  };
  const done=async(receipt:Receipt)=>{
    checkpoint.receipt=receipt;await atomicJson(path,checkpoint);return receipt;
  };
  if(saved.failure)return stop(saved.failure);
  if(saved.receipt)return saved.receipt;
  for(;;){
    job.signal.throwIfAborted();
    const last=saved.attempts.at(-1);
    if(last){
      const until=Date.now()+deps.graceMs;
      for(;;){
        let observation;
        try{observation=await deps.observe(job,last);}
        catch(error){if(error instanceof Error && /declined or interrupted/.test(error.message))return stop('The harness declined or interrupted the mandatory review');throw error;}
        if(observation.refused)return stop(refusal);
        if(observation.receipt)return done(observation.receipt);
        if(!observation.live)break;
        if(Date.now()>=until)return stop(uncertain);
        await deps.pause();
      }
    }
    if(saved.attempts.length>=2)return stop(unavailable);
    const attempt={challenge:randomUUID(),startedAt:Date.now()} as Attempt;
    saved.attempts.push(attempt);await atomicJson(path,saved);
    if(saved.attempts.length>1)for(const issue of job.issues)recordProgress(job.state,issue,'review-retry:'+job.role+':'+job.revision,
      'LEO reconciled the original '+job.role+' assignment for `'+job.revision+'` and found no verified review. One bounded native review retry has been assigned.');
    try{return await done(await deps.run({...job,input:saved.input},attempt.challenge));}
    catch(error){
      if(job.signal.aborted)throw error;
      const message=error instanceof Error?error.message:'';
      if(/refused this stage/.test(message))return stop(refusal);
      if(/declined or interrupted/.test(message))return stop('The harness declined or interrupted the mandatory review');
      if(!/receipt timed out|runtime exited before verified receipt/.test(message))return stop('The mandatory review could not establish a unique result');
      attempt.endedAt=Date.now();await atomicJson(path,saved);
    }
  }
}
