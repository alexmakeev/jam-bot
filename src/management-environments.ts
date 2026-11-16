import {randomUUID} from 'node:crypto';
import {link,mkdir,open,readFile,readdir,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {appReader} from './github-app.js';
import {checkCurrentRole} from './github-authorization.js';
import {runEnvironment} from './environment-runner.js';
import {ManagementError,requireServer,requireTopic,targetFields,type ManagementOperation} from './management-contract.js';
import type {TopicRuntime} from './topics.js';

const environment = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const alias = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const address=z.literal('127.0.0.1');
const endpoint=z.strictObject({address,port:z.int().min(1024).max(65535)});
const appName=z.string().regex(/^APP_[A-Z][A-Z0-9_]{0,47}$/)
  .refine(name=>!/(?:SECRET|PASSWORD|TOKEN|PRIVATE|CREDENTIAL|API_KEY|AUTH)/.test(name),'Use secret references for credentials');
const appVariables=z.record(appName,z.string().max(256).regex(/^[a-zA-Z0-9._ /:,+-]*$/))
  .refine(values=>Object.keys(values).length<=32,'Too many application settings');
const settings = z.strictObject({
  appVariables:appVariables.default({}),
  endpoint:endpoint.nullable().default(null),
  logLevel:z.enum(['debug','info','warn','error']).default('info'),
  secretRefs:z.array(alias).max(16).refine(values=>new Set(values).size===values.length,'Duplicate secret reference').default([]),
});
const definition = z.strictObject({
  environment, tier:z.enum(['development','staging','stable']), settings,
});
const target = z.strictObject(targetFields);
const identified = target.extend({environment});
const deployInput = identified.extend({revision,approvalCommentId:z.int().positive().optional()});
const deployment = z.strictObject({
  publication:z.strictObject({url:z.string().url(),manifestSha256:z.string().regex(/^[0-9a-f]{64}$/),objectCount:z.number().int().positive(),verifiedAt:z.string().datetime(),cacheVerified:z.literal(true)}).optional(),
  environment,running:z.boolean(),healthy:z.boolean(),revision:revision.nullable(),image:z.string().nullable(),endpoint:endpoint.nullable().optional(),
});
type Definition = z.infer<typeof definition>;
type ApprovalVerifier = (route:TopicRuntime,id:number,statement:string)=>Promise<void>;

export function stableApprovalStatement(repository:string, name:string, serverId:string, sha:string):string {
  return 'Approve JAM-Bot stable deployment of '+repository+' to '+name+' on '+serverId+' at '+sha+'.';
}

async function verifyStableApproval(route:TopicRuntime,id:number,statement:string) {
  const topic=route.topic;
  const read=await appReader(topic.repository,String(topic.installation));
  const path='repos/'+topic.repository;
  const [repo,comment]=await Promise.all([read(path),read(path+'/issues/comments/'+id)]);
  if (repo.id!==topic.repoId || comment.id!==id || comment.body!==statement ||
    typeof comment.created_at!=='string' || comment.updated_at!==comment.created_at || comment.user?.type!=='User' || typeof comment.user.login!=='string' ||
    !/^[a-zA-Z0-9-]+$/.test(comment.user.login) || comment.performed_via_github_app)
    throw new ManagementError(403,'invalid_stable_approval','The original human approval must match this deployment exactly.');
  const role=await read(path+'/collaborators/'+encodeURIComponent(comment.user.login)+'/permission');
  try { checkCurrentRole(comment.user,repo,role); } catch { throw new ManagementError(403,'invalid_approver','The approver must be a current repository owner or maintainer.'); }
}

export function environmentOperations(_state:string,routes:ReadonlyMap<string,TopicRuntime>,instanceId:string,
  runner:typeof runEnvironment=runEnvironment, approve:ApprovalVerifier=verifyStableApproval):ManagementOperation[] {
  function getTarget(input:z.infer<typeof target>) {
    requireServer(instanceId,input.serverId);
    return requireTopic(routes,input.repoId);
  }
  function dir(route:TopicRuntime,name:string) {
    return join(route.state,'environments',environment.parse(name));
  }
  async function get(route:TopicRuntime,name:string):Promise<Definition> {
    const path=join(dir(route,name),'definition.json');
    let text;
    try { text=await readFile(path,'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
      throw new ManagementError(404,'environment_not_found','The requested environment has no definition in this project.');
    }
    const result=definition.safeParse(JSON.parse(text));
    if (!result.success || result.data.environment!==name) throw new ManagementError(409,'invalid_definition','The stored environment definition is inconsistent.');
    return result.data;
  }
  async function save(route:TopicRuntime,value:Definition) {
    const folder=dir(route,value.environment);
    await mkdir(folder,{recursive:true,mode:0o700});
    const path=join(folder,'definition.json');
    const temporary=join(folder,'.'+randomUUID()+'.tmp');
    const file=await open(temporary,'wx',0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(value,null,2)+'\n');
        await file.sync();
      } finally { await file.close(); }
      // The first writer establishes the immutable tier without publishing a partial file.
      try { await link(temporary,path); }
      catch(error) {
        if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
        const prior=await get(route,value.environment);
        if (prior.tier!==value.tier) throw new ManagementError(409,'tier_conflict','An existing environment cannot change its lifecycle tier.');
        await rename(temporary,path);
      }
      const directory=await open(folder,'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return value;
    } finally { await rm(temporary,{force:true}); }
  }
  async function list(route:TopicRuntime) {
    const root=join(route.state,'environments');
    let entries;
    try { entries=await readdir(root,{withFileTypes:true}); }
    catch(error) {
      if ((error as NodeJS.ErrnoException).code==='ENOENT') return [];
      throw error;
    }
    const values:Definition[]=[];
    for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !environment.safeParse(entry.name).success) continue;
      try { values.push(await get(route,entry.name)); }
      catch(error) {
        // A first writer may have created the directory before publishing definition.json.
        if (!(error instanceof ManagementError) || error.code!=='environment_not_found') throw error;
      }
    }
    return values;
  }
  async function host(input:Parameters<typeof runEnvironment>[0]) {
    try { return await runner(input); }
    catch(error) {
      if (error instanceof ManagementError) throw error;
      throw new ManagementError(503,'host_operation_failed','The environment runner could not verify the requested operation.');
    }
  }
  function hostSettings(value:Definition) {
    return {tier:value.tier,config:{LOG_LEVEL:value.settings.logLevel},secretRefs:value.settings.secretRefs,
      appVariables:value.settings.appVariables,...(value.settings.endpoint ? {endpoint:value.settings.endpoint} : {})};
  }
  const listOut=z.strictObject({environments:z.array(definition)});
  return [
    {name:'environment_list',description:'List stored environment definitions for one project.',input:target,output:listOut,mutate:false,
      run:async input=>({environments:await list(getTarget(input))})},
    {name:'environment_get',description:'Get one environment definition.',input:identified,output:definition,mutate:false,
      run:async input=>get(getTarget(input),input.environment)},
    {name:'environment_upsert',description:'Save application settings and names of host-approved secrets for an environment. Its lifecycle tier is immutable.',
      input:target.extend(definition.shape),output:definition,mutate:true,run:async input=>{
        const route=getTarget(input);
        const value=definition.parse({environment:input.environment,tier:input.tier,settings:input.settings});
        return save(route,value);
      }},
    {name:'environment_deploy',description:'Deploy an immutable revision using the host-approved environment recipe. Stable requires an exact owner or maintainer approval comment.',
      input:deployInput,output:deployment,mutate:true,run:async input=>{
        const route=getTarget(input);
        const env=await get(route,input.environment);
        if (env.tier==='stable') {
          if (!input.approvalCommentId) throw new ManagementError(403,'stable_approval_required','A separate approval comment is required for this stable deployment.');
          try {
            await approve(route,input.approvalCommentId,stableApprovalStatement(route.topic.repository,env.environment,instanceId,input.revision));
          } catch(error) {
            if (error instanceof ManagementError) throw error;
            throw new ManagementError(503,'approval_unavailable','Stable approval could not be verified with GitHub.');
          }
        }
        return host({serverId:instanceId,repoId:route.topic.repoId,environment:env.environment,action:'deploy',revision:input.revision,...hostSettings(env)});
      }},
    ...(['status','stop'] as const).map(action=>({
      name:'environment_'+action,description:action==='status'?'Inspect the host runtime for a configured environment.':'Stop the configured runtime for one project environment.',
      input:identified,output:deployment,mutate:action==='stop',run:async(input:z.infer<typeof identified>)=>{
        const route=getTarget(input);
        const env=await get(route,input.environment);
        return host({serverId:instanceId,repoId:route.topic.repoId,environment:env.environment,action,...hostSettings(env)});
      }
    })),
  ];
}
