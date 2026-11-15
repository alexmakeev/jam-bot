import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Journal, type Topic } from './intake-journal.js';
import { BranchValidation } from './branch-validation.js';
import { IntegrationQueue, type IntegrationBatch, type ReadyBranch } from './integration-queue.js';
import { runRoleStage, applyRoleFiles, type StageRole } from './role-harness.js';
import { checkout, exchange, git } from './profile-checkout.js';
import { completeCard, publishSpecification, requestFileScope, setCardProgress } from './profile-publication.js';
import type { ProfileCard } from './profile-card.js';
import { validateTaskApproval, type TaskApproval } from './task-approval.js';
import { atomicJson, readJson } from './storage.js';
import type { TopicRuntime } from './topics.js';

interface ProfileRun {
  topic:Topic; state:string; lead:string; issue:number; card:ProfileCard; signal:AbortSignal;
  authorize:()=>Promise<void>; approval:TaskApproval;
}
type Project = Awaited<ReturnType<typeof checkout>>;
interface Ready {project:Project;sha:string;card:ProfileCard;spec:string;approval:TaskApproval}
const directory=(state:string,issue:number)=>join(state,'assignments',String(issue));

async function stage(p:ProfileRun,role:StageRole,input:string){
  await p.authorize();
  const receipt=await runRoleStage({role,state:p.state,cwd:p.topic.cwd,session:p.lead,issue:p.issue,input,signal:p.signal});
  await atomicJson(join(directory(p.state,p.issue),role+'.json'),receipt);
  return receipt.output;
}

export async function projectContext(tree:string, files:string[], references:string) {
  const names=(await git(tree,'ls-files','-z')).split('\0').filter(Boolean);
  const parts=['Tracked files: '+JSON.stringify(names)];
  // A referenced implementation or neighboring test is read-only context for the teammate.
  const referenced=names.filter(name=>/\.(?:[cm]?[jt]sx?|md)$/.test(name) && references.includes(name));
  const required=new Set(['.jam-bot/VALUES.md','README.md',...files]);
  let remainingReferenceBytes=16000;
  for(const file of new Set([...required,...referenced])){
    const path=join(tree,file);
    if(!names.includes(file))continue;
    const info=await lstat(path);
    if(!required.has(file)){
      if(!info.isFile() || info.size>remainingReferenceBytes)continue;
      remainingReferenceBytes-=info.size;
    }
    if(!info.isFile()||await realpath(path)!==path||info.size>16384)throw Error('Unsupported project context file: '+file);
    parts.push(file+'\n'+await readFile(path,'utf8'));
  }
  return parts.join('\n\n');
}

export async function runDeveloperProfile(p:ProfileRun) {
  const {card,topic,issue,state,signal}=p;
  const dir=directory(state,issue);
  await mkdir(dir,{recursive:true,mode:0o700});
  try{
    if(card.kind!=='development'){
      await setCardProgress(topic,issue,'in progress');
      const output=await stage(p,card.kind==='consultation'?'consultant':'assignment',
        'Answer this approved request directly in English. Return concise GitHub Markdown suitable for an issue comment. Preserve separate steps as a list.\n'+card.task);
      await atomicJson(join(dir,'result.json'),{kind:card.kind,output});
      await p.authorize();
      await completeCard(topic,issue,output);
      return;
    }
    await setCardProgress(topic,issue,'planning');
    await p.authorize();
    if(!card.files.length) {
      const plan=await stage(p,'architect','Return only a short numbered Markdown list of two to four steps for this exact task. JAM-Bot development routes are team workflows. Avoid assumptions about application routes or frameworks. Identify the file scope needed before edits.\n'+card.task);
      await atomicJson(join(dir,'plan.json'),{kind:'development',plan,waiting:'file-scope'});
      await p.authorize();
      await requestFileScope(topic,issue,plan);
      return;
    }
    const progress=new Journal(join(state,'intake.sqlite'));
    const scope=JSON.stringify({task:card.task,files:card.files});
    let project:Project;
    let spec:string;
    try {
      const saved=progress.specificationCheckpoint(issue);
      if(saved) {
        project=JSON.parse(saved) as Project;
        if(project.tree!==join(state,'worktrees',String(issue)) || project.store!==join(state,'project.git') ||
            await git(project.tree,'rev-parse','HEAD')!==project.base ||
            await git(project.tree,'branch','--show-current')!==project.branch ||
            await git(project.tree,'status','--porcelain'))throw Error('Specification worktree changed during restart');
        spec=(await readJson<{output:string}>(join(dir,'architect.json'))).output;
      } else {
        project=await checkout(state,topic.repository,issue,signal);
        const brief=await projectContext(project.tree,card.files,card.task);
        spec=await stage(p,'architect','Return a compact English Markdown implementation specification, including acceptance tests.\n'+scope+'\n'+brief);
        progress.checkpointSpecification(issue,JSON.stringify(project));
      }
      await publishSpecification({topic,issue,markdown:spec,signal,authorize:p.authorize});
      progress.checkpointSpecification(issue,null);
    } finally { progress.db.close(); }
    await setCardProgress(topic,issue,'in progress');
    const assignment=await stage(p,'assignment','Prepare the developer handoff from this approved scope and specification.\n'+scope+'\n'+spec);
    const implementationContext=await projectContext(project.tree,card.files,card.task+'\n'+spec+'\n'+assignment);
    const output=await stage(p,'developer','Implement the approved task. Return raw JSON {"files":[{"path":"approved/path","content":"entire file text"}]}. For tests use the existing project build and import conventions, node:test and node:assert/strict, no new dependencies.\n'+scope+'\n'+spec+'\n'+assignment+'\n'+implementationContext);
    for(const file of card.files){
      let parent=project.tree;
      for(const part of file.split('/').slice(0,-1)){
        parent=join(parent,part);await mkdir(parent).catch((err:NodeJS.ErrnoException)=>{if(err.code!=='EEXIST')throw err;});
        if(await realpath(parent)!==parent)throw Error('Unsafe checkout directory');
      }
    }
    await p.authorize();
    const paths=await applyRoleFiles(project.tree,card.files,output);
    await git(project.tree,'add','--',...paths);
    const diff=await git(project.tree,'diff','--cached','--no-ext-diff');
    if(!diff)throw Error('Development produced no change');
    await git(project.tree,'commit','-m','Implement work card '+issue);
    const sha=await git(project.tree,'rev-parse','HEAD');
    const request={repo:topic.repository,sha,base:project.base,expected:project.expected,cards:[{issue,approval:p.approval}]};
    const testStarted=Date.now();
    const tests=await exchange(project.store,{action:'test-head',...request},signal);
    const elapsedMs=Math.max(1,Date.now()-testStarted);
    const review=await stage(p,'consultant','Review code for correctness against the supplied task, spec and test report. Begin with PASS or FAIL, followed by a concise rationale.\n'+scope+'\n'+spec+'\n'+diff+'\n'+tests.log);
    if(!/^PASS\b/i.test(review.trim()))throw Error('Code review needs correction: '+review.slice(0,500));
    await atomicJson(join(dir,'ready.json'),{project,sha,card,spec,approval:p.approval} satisfies Ready);
    await setCardProgress(topic,issue,'queued');
    const journal=new Journal(join(state,'intake.sqlite'));
    try {new BranchValidation(journal.db).submit({issue,branch:project.branch,sha},elapsedMs);}
    finally {journal.db.close();}
  }catch(err){if(!signal.aborted)await setCardProgress(topic,issue,'blocked').catch(()=>{});throw err;}
}

export async function validateReviewedHead(runtime:TopicRuntime,head:ReadyBranch,signal:AbortSignal) {
  const dir=directory(runtime.state,head.issue);
  try {
    const {project,sha,approval}=await readJson<Ready>(join(dir,'ready.json'));
    if(sha!==head.sha || project.branch!==head.branch)throw Error('Reviewed head no longer matches handoff');
    const checked=await exchange(project.store,{action:'test-head',repo:runtime.topic.repository,sha,
      base:project.base,expected:project.expected,cards:[{issue:head.issue,approval}]},signal);
    if(checked.sha!==sha)throw Error('Validation returned a different revision');
    await atomicJson(join(dir,'reviewed-head-tests.json'),{sha,tests:checked.tests,log:checked.log});
  } catch(err) {
    if(!signal.aborted)await setCardProgress(runtime.topic,head.issue,'blocked').catch(()=>{});
    throw err;
  }
}

export async function integrateReady(runtime:TopicRuntime,signal:AbortSignal,queue:IntegrationQueue,batch:IntegrationBatch) {
  const {state,topic,journal}=runtime;
  const dir=join(state,'integration',batch.id);
  const marker=join(dir,'candidate.json');
  const candidateTree=join(dir,'worktree');
  const store=join(state,'project.git');
  await mkdir(dir,{recursive:true});
  let published=false;
  try{
    const entries=await Promise.all(batch.entries.map(async head=>{
      const ready=await readJson<Ready>(join(directory(state,head.issue),'ready.json'));
      if(ready.sha!==head.sha || ready.project.branch!==head.branch)throw Error('Recorded branch mismatch');
      return {...head,...ready};
    }));
    const seed=await exchange(store,{action:'seed',repo:topic.repository},signal);
    let candidate=await readJson<{sha:string;base:string;expected:string}>(marker).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
    if(candidate && seed.dev===candidate.sha)published=true;
    if(!published){
      const verifyApproval=async()=>{
        for(const entry of entries) {
          if(!entry.approval)throw Error('Existing handoff has no native Task approval; reconcile before integration');
          await validateTaskApproval(topic,entry.issue,entry.approval);
        }
      };
      await verifyApproval();
      for(const entry of entries)await setCardProgress(topic,entry.issue,'in validation');
      if(!candidate){
        await git(store,'worktree','add','--detach',candidateTree,seed.sha);
        for(const entry of entries)await git(candidateTree,'merge','--no-edit',entry.sha);
        candidate={sha:await git(candidateTree,'rev-parse','HEAD'),base:seed.sha,expected:seed.dev??''};
        await atomicJson(marker,candidate);
      }
      const req={repo:topic.repository,...candidate,cards:entries.map(({issue,approval})=>({issue,approval}))};
      const tested=await exchange(store,{action:'test',...req},signal);
      await atomicJson(join(dir,'tests.json'),tested);
      const review=await runRoleStage({role:'integrator',state,cwd:topic.cwd,session:journal.lead().id,issue:entries[0]!.issue,signal,
        input:'You are deciding whether to publish this exact tested candidate to dev. Evaluate implementation, test outcomes, and proposed integration. Return PASS or FAIL on the first line, followed by reasons. The publisher reruns the suite and performs the guarded dev push only after your approval. Closing the issue and cleanup also follow publication.\n'+
          JSON.stringify({base:candidate.base, devBefore:candidate.expected || null, candidate:candidate.sha, featureHeads:entries.map(e=>({issue:e.issue,branch:e.branch,sha:e.sha})), candidateStatus:await git(candidateTree,'status','--porcelain'), commit:await git(candidateTree,'log','-1','--oneline','--stat')})+'\n'+
          JSON.stringify(entries.map(e=>({issue:e.issue,task:e.card.task,spec:e.spec})))+'\n'+
          await git(candidateTree,'diff','--no-ext-diff',candidate.base,candidate.sha)+'\n'+tested.log});
      await atomicJson(join(dir,'integrator.json'),review);
      if(!/^PASS\b/i.test(review.output.trim()))throw Error('Integrator requested a fix: '+review.output.slice(0,500));
      await verifyApproval();
      await exchange(store,{action:'publish',...req},signal);
      published=true;
    }
    for(const e of entries){
      const summary='Integrated '+e.sha.slice(0,12)+' into dev at '+candidate!.sha.slice(0,12)+'. The full configured test suite passed.';
      await atomicJson(join(directory(state,e.issue),'result.json'),{issue:e.issue,head:e.sha,dev:candidate!.sha,batch:batch.id,summary});
      await completeCard(topic,e.issue,summary);
      if(await realpath(e.project.tree).catch(()=>undefined)){
        if(await git(e.project.tree,'status','--porcelain'))throw Error('Worktree contains uncommitted changes');
        if(await git(e.project.tree,'rev-parse','HEAD')!==e.sha)throw Error('Worktree advanced after handoff');
        await git(store,'worktree','remove',e.project.tree);
      }
      if(await git(store,'branch','--list',e.branch)) {
        await git(store,'update-ref','-d','refs/heads/'+e.branch,e.sha);
      }
    }
    if(await realpath(candidateTree).catch(()=>undefined))await git(store,'worktree','remove',candidateTree);
    queue.finish(batch.id,'integrated');
  }catch(err){
    const error=err instanceof Error ? err.message : 'Integration failed';
    await atomicJson(join(dir,'failure.json'),{error,published});
    // Preserve active state on uncertain publication and recover against remote dev after restart.
    if(published || signal.aborted || error.includes('requires reconciliation'))throw err;
    queue.finish(batch.id,'failed');
    for(const e of batch.entries)await setCardProgress(topic,e.issue,'blocked').catch(()=>{});
    console.error('Integration needs review',topic.repository,error);
  }
}
