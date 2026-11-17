import {mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {Topic} from './intake-journal.js';
import type {StageRole} from './role-harness.js';
import {loadProjectValues,responsible,type ProjectValues} from './project-values.js';
import {atomicJson,readJson} from './storage.js';
import {confirmedProgress,fingerprint,recordProgress} from './work-progress.js';

export type RoleFailureCategory='harness_refusal'|'missing_result'|'uncertain_execution'|'runtime_failure';
const descriptions:Record<RoleFailureCategory,string>={
  harness_refusal:'The harness refused or interrupted the invocation before a verified response was received.',
  missing_result:'The role returned no verified result after bounded recovery.',
  uncertain_execution:'The previous role execution may still be active; ownership requires reconciliation.',
  runtime_failure:'The role could not complete its assigned stage; saved runtime evidence requires inspection.',
};
const labels:Record<StageRole,string>={architect:'Architect',developer:'Worker',integrator:'Integrator',consultant:'Consultant',designer:'Designer',assignment:'Assignment'};
const areas:Record<StageRole,string>={architect:'architecture',developer:'development',integrator:'integration',consultant:'code review',designer:'design',assignment:'project lead'};

export class RoleStageFailure extends Error {
  constructor(readonly role:StageRole,readonly category:RoleFailureCategory,readonly localDetail:string){
    super(labels[role]+' stage stopped. '+descriptions[category]);
    this.name='RoleStageFailure';
    Object.defineProperty(this,'localDetail',{enumerable:false});
  }
}

export function roleStageFailure(role:StageRole,error:unknown):RoleStageFailure {
  if(error instanceof RoleStageFailure)return error;
  const detail=error instanceof Error?error.message:String(error);
  const category:RoleFailureCategory=/refus|declin|safety classifier/i.test(detail)?'harness_refusal':
    /may still be active|ownership|reconciliation|reconcile/i.test(detail)?'uncertain_execution':
    /no verified|no verifiable|receipt timed out|missing.*result/i.test(detail)?'missing_result':'runtime_failure';
  return new RoleStageFailure(role,category,detail);
}

interface RoleIncident {
  issue:number;role:StageRole;category:RoleFailureCategory;detail:string;identity:string;createdAt:string;commentId?:number;
}
interface FailureRequest {state:string;topic:Topic;issue:number;error:unknown;role?:StageRole}
interface FailureDependencies {
  profile:(request:FailureRequest)=>Promise<ProjectValues>;
  record:typeof recordProgress;
  confirm:typeof confirmedProgress;
}
const dependencies:FailureDependencies={
  profile:async ({state,topic,issue})=>readJson<ProjectValues>(join(state,'assignments',String(issue),'project-values.json')).catch((error:NodeJS.ErrnoException)=>{
    if(error.code!=='ENOENT')throw error;
    return loadProjectValues(topic);
  }),
  record:recordProgress,confirm:confirmedProgress,
};

async function savedRoleFailure(state:string,issue:number){
  const directory=join(state,'assignments',String(issue),'roles');
  const files=await readdir(directory).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;return [];});
  const failures: {role:StageRole;detail:string;startedAt:number}[]=[];
  for(const file of files){
    const role=file.split('-')[0] as StageRole;
    if(!Object.hasOwn(labels,role)||!file.endsWith('.json'))continue;
    const saved=await readJson<{failure?:string;failureDetail?:string;startedAt?:number}>(join(directory,file));
    if(saved.failure)failures.push({role,detail:saved.failureDetail??saved.failure,startedAt:saved.startedAt??0});
  }
  return failures.sort((a,b)=>b.startedAt-a.startedAt)[0];
}

// This operation publishes incident evidence only. It never dispatches or retries a role.
export async function publishRoleFailure(request:FailureRequest,deps:FailureDependencies=dependencies){
  const {state,topic,issue,error}=request;
  if(!Number.isSafeInteger(issue)||issue<1)throw Error('Invalid role incident issue');
  const message=error instanceof Error?error.message:String(error);
  const named=/\b(architect|developer|integrator|consultant|designer|assignment)\b/i.exec(message)?.[1]?.toLowerCase() as StageRole|undefined;
  const known=request.role??(error instanceof RoleStageFailure?error.role:named);
  const saved=known?undefined:await savedRoleFailure(state,issue);
  const role=known??saved?.role??'developer';
  if(!Object.hasOwn(labels,role))throw Error('Invalid incident role');
  const failure=roleStageFailure(role,saved?.detail??error);
  const identity='blocked:'+fingerprint(JSON.stringify({issue,role:failure.role,category:failure.category,detail:failure.localDetail}));
  const directory=join(state,'role-incidents',String(issue));
  await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,fingerprint(identity)+'.json');
  const previous=await readJson<RoleIncident>(path).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;});
  const incident:RoleIncident=previous??{issue,role:failure.role,category:failure.category,detail:failure.localDetail,identity,createdAt:new Date().toISOString()};
  if(incident.commentId)return {identity,commentId:incident.commentId,role:incident.role,category:incident.category};
  await atomicJson(path,incident);
  const owner=responsible(await deps.profile(request),areas[incident.role]);
  if(!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner))throw Error('Invalid role incident recipient');
  const outcome=descriptions[incident.category];
  const next=incident.category==='harness_refusal'?'Inspect the original harness incident and reconcile any partial execution. Record a maintainer decision before further work on this stage.':
    'Inspect the saved runtime evidence and reconcile the last unfinished action before continuing.';
  const summary='❓ @'+owner+' — '+labels[incident.role]+' stage is blocked. '+outcome+' Can you inspect the saved incident and record the next action?';
  const markdown='# Role execution incident\n\nRole: '+labels[incident.role]+'\n\nCategory: '+incident.category+'\n\n## Observed outcome\n\n'+outcome+
    '\n\n## Effect on the work card\n\nThe stage has no verified result. The work card remains open and its saved checkpoint is retained.\n\n## Required next action\n\n'+next+
    '\n\n## Evidence handling\n\nDetailed runtime diagnostics remain in the server-owned incident record. This report contains no prompts, terminal output, credentials or provider-specific assumptions.\n';
  deps.record(state,issue,identity,summary,{purpose:'review',markdown});
  incident.commentId=await deps.confirm(state,topic,issue,identity);
  await atomicJson(path,incident);
  return {identity,commentId:incident.commentId,role:incident.role,category:incident.category};
}
