import {readProjectSource} from './runtime/project-values-reader.js';
// Local dev publisher for explicitly selected repositories. The service only exchanges Git bundles.
import {consultAll,selectedConsultants} from './consultants.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {calculatorRepo,queueCalculator,reconcileCalculator,sandboxRepo,queueSandbox,reconcileSandbox} from './calculator-deployment.mjs';
import {projectRecipes,testCandidate} from './profile-recipes.mjs';
import { brokerFiles } from './runtime/broker-approval.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, realpath, lstat, rename, rm, writeFile, mkdtemp, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const root = await realpath(process.argv[2]);
const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
const projects = projectRecipes(config);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const git = async (cwd,args) => (await run('git',['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','credential.helper=!gh auth git-credential',...args],
  {cwd,timeout:60000,maxBuffer:2**20,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout.trimEnd();
const gh = async path => JSON.parse((await run('gh',['api',path],{timeout:30000,maxBuffer:2**20})).stdout);

async function revoked(repo){
  try{await lstat(join(root,'revoked',repo.toLowerCase()));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}
}
async function regular(path,limit) {
  const st=await lstat(path);
  if (!st.isFile() || st.nlink!==1 || st.size>limit) throw Error('Invalid broker input file');
}
async function authorizedFiles(req){
  if (!Array.isArray(req.cards)||req.cards.length<1||req.cards.length>15) throw Error('Invalid work cards');
  const allowed=new Set();
  for(const card of req.cards){
    if(!Number.isSafeInteger(card.issue)||card.issue<1)throw Error('Invalid issue');
    const base='repos/'+req.repo;
    const issue=await gh(base+'/issues/'+card.issue);
    const paths=await brokerFiles(card.issue,issue,card.approval,login=>gh(base+'/collaborators/'+encodeURIComponent(login)+'/permission'));
    for(const path of paths)allowed.add(path);
  }
  return allowed;
}

function requiresLiveAcceptance(req){
  const project=projects[req.repo];
  return req.repo===calculatorRepo && project?.autoDeployCalculator===true &&
    Array.isArray(req.cards) && req.cards.some(card=>card.issue===project.calculatorSpecCards?.staticSvg);
}

async function execute(dir) {
  await regular(join(dir,'request.json'),1024*1024);
  const req=JSON.parse(await readFile(join(dir,'request.json'),'utf8'));
  if (!/^[\w.-]+\/[\w.-]+$/.test(req.repo)) throw Error('Repository outside publisher scope');
  if(await revoked(req.repo))throw Error('GitHub App repository grant was revoked');
  if(req.action==='project-profile'){
    if (!Object.hasOwn(projects,req.repo) && config.profileReaders?.[req.repo] !== req.repoId) throw Error('Repository outside profile reader scope');
    if(!Number.isSafeInteger(req.repoId)||req.repoId<=0)throw Error('Missing repository identity');
    const policy=projects[req.repo]?.releaseProfile;
    if(policy && policy.repoId!==req.repoId)throw Error('Installed project identity mismatch');
    return readProjectSource(req.repo,req.repoId,policy?.profileRef,gh);
  }
  if (!Object.hasOwn(projects,req.repo)) throw Error('Repository outside publisher scope');
  if(req.action==='consult'){
    await authorizedFiles(req);
    const providers=new Map();
    let written=Promise.resolve();
    const progress=event=>{
      providers.set(event.name,event);
      const bytes=JSON.stringify({phase:req.phase,updatedAt:event.updatedAt,providers:[...providers.values()]});
      written=written.then(async()=>{
        await writeFile(join(dir,'progress.tmp'),bytes,{mode:0o600,flag:'wx'});
        await rename(join(dir,'progress.tmp'),join(dir,'progress.json'));
      });
      return written;
    };
    return consultAll(selectedConsultants(projects[req.repo].consultants,req.only),req.phase,req.packet,undefined,progress);
  }
  const url='https://github.com/'+req.repo+'.git';
  const temp=await mkdtemp(join(tmpdir(),'jam-broker-'));
  try {
    await git(temp,['init','--bare','-q']);
    await git(temp,['remote','add','origin',url]);
    const remote=await git(temp,['ls-remote','origin','refs/heads/dev']);
    const dev=remote.split(/\s+/)[0] || '';
    if (req.action==='seed') {
      const source=dev?'dev':(await gh('repos/'+req.repo)).default_branch;
      await git(temp,['fetch','--no-tags','origin','refs/heads/'+source+':refs/heads/seed']);
      const bundle=join(temp,'seed.bundle');
      await git(temp,['bundle','create',bundle,'refs/heads/seed']);
      await copyFile(bundle,join(dir,'seed.bundle'),constants.COPYFILE_EXCL);
      return {sha:await git(temp,['rev-parse','refs/heads/seed']),dev};
    }
    if (!['test-head','test','publish'].includes(req.action) || !sha(req.sha) || !sha(req.base) || !(req.expected===''||sha(req.expected))) throw Error('Invalid candidate');
    const files=await authorizedFiles(req);
    if(req.action==='publish' && dev===req.sha) return {sha:dev,alreadyPublished:true,awaitDeployment:requiresLiveAcceptance(req)};
    if(req.action!=='test-head' && dev!==req.expected) throw Error('Remote dev changed during validation');
    const baseRef=dev?'dev':(await gh('repos/'+req.repo)).default_branch;
    await git(temp,['fetch','--no-tags','origin','refs/heads/'+baseRef+':refs/heads/base']);
    if(req.action==='test-head')await git(temp,['merge-base','--is-ancestor',req.base,'refs/heads/base']);
    else if(await git(temp,['rev-parse','refs/heads/base'])!==req.base) throw Error('Candidate base is stale');
    const bundle=join(dir,'candidate.bundle'); await regular(bundle,32*1024*1024);
    await git(temp,['fetch','--no-tags',bundle,'refs/heads/export:refs/heads/candidate']);
    if(await git(temp,['rev-parse','refs/heads/candidate'])!==req.sha)throw Error('Candidate object mismatch');
    await git(temp,['merge-base','--is-ancestor',req.base,req.sha]);
    // Inspect every new commit to prevent smuggling unapproved historical contents in the push.
    for(const revision of (await git(temp,['rev-list',req.base+'..'+req.sha])).split('\n').filter(Boolean)){
      const paths=(await git(temp,['diff-tree','--root','-m','--no-commit-id','--name-only','--no-renames','-r','-z',revision])).split('\0').filter(Boolean);
      if(paths.some(path=>!files.has(path)))throw Error('Commit outside approved file scope');
    }
    const tree=join(temp,'code');await git(temp,['worktree','add','--detach',tree,req.sha]);
    const filesForCandidate=(await git(tree,['ls-files','-z'])).split('\0').filter(Boolean);
    const {tests,log}=await testCandidate({project:projects[req.repo],tree,files:filesForCandidate,
      sha:req.sha,base:req.base,name:'jam-check-'+basename(dir),approvedIssues:req.cards.map(card=>card.issue)});
    if(req.action==='publish') {
      await authorizedFiles(req);
      await queueCalculator(projects[req.repo],req);
      await queueSandbox(projects[req.repo],req);
      if(await revoked(req.repo))throw Error('GitHub App repository grant was revoked');
      await git(temp,['push','--force-with-lease=refs/heads/dev:'+req.expected,'origin',req.sha+':refs/heads/dev']);
      if(!(await git(temp,['ls-remote','origin','refs/heads/dev'])).startsWith(req.sha+'\t'))throw Error('Publication requires reconciliation');
    }
    return {sha:req.sha,tests,log:log.slice(-8000),awaitDeployment:req.action==='publish' && requiresLiveAcceptance(req)};
  } finally {await rm(temp,{recursive:true,force:true});}
}
async function reply(dir) {
  let answer;
  try{answer={ok:true,value:await execute(dir)};}catch(e){answer={ok:false,error:String(e.message).slice(-10000)};}
  await writeFile(join(dir,'answer.tmp'),JSON.stringify(answer),{mode:0o600,flag:'wx'});
  await rename(join(dir,'answer.tmp'),join(dir,'answer.json'));
}

// A service restart may occur after claim or after writing the result but before renaming it.
// This path observes existing evidence without issuing another consultation or push.
async function recoverClaim(dir,id){
  if(await lstat(join(dir,'answer.json')).catch(()=>null))return;
  const claimed=join(dir,'request.json');
  try{await regular(claimed,1024*1024);}catch(e){if(e.code==='ENOENT')return;throw e;}
  const req=JSON.parse(await readFile(claimed,'utf8'));
  if(req.brokerRequestId!==id)return;
  const staged=join(dir,'answer.tmp');
  const pending=await readFile(staged,'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;});
  if(pending){
    try{const result=JSON.parse(pending);if(typeof result.ok!=='boolean')throw Error('Incomplete answer');}
    catch{return storeUncertain(dir);}
    await rename(staged,join(dir,'answer.json'));return;
  }
  if(req.action==='publish' && Object.hasOwn(projects,req.repo) && sha(req.sha)){
    const current=await gh('repos/'+req.repo+'/git/ref/heads/dev');
    if(current.object?.sha===req.sha){
      await writeFile(staged,JSON.stringify({ok:true,value:{sha:req.sha,alreadyPublished:true,awaitDeployment:requiresLiveAcceptance(req)}}),{mode:0o600,flag:'wx'});
      await rename(staged,join(dir,'answer.json'));return;
    }
  }
  await storeUncertain(dir);
}
async function storeUncertain(dir){
  const file=join(dir,'uncertain.tmp');
  await writeFile(file,JSON.stringify({ok:false,uncertain:true,error:'Host restarted after claiming the request and has no confirmed result.'}),{mode:0o600});
  await rename(file,join(dir,'answer.json'));
}

await mkdir(root,{recursive:true});
const consultations=new Set(),running=new Set();
do {
  for(const id of await readdir(root)){
    if(!/^[a-f0-9-]{36}$/.test(id))continue;
    const dir=join(root,id);
    if(await realpath(dir).catch(()=>null)!==dir)continue;
    const pending=join(dir,'request.ready');
    let consult=false;
    try{
      await regular(pending,1024*1024);
      consult=JSON.parse(await readFile(pending,'utf8')).action==='consult';
    }catch(error){if(error.code==='ENOENT'){
      if(!running.has(id))await recoverClaim(dir,id).catch(error=>console.error('Cannot reconcile publisher request',id,error.code??error.name));
      continue;
    }throw error;}
    if(consult && consultations.size>=4)continue;
    try{await rename(pending,join(dir,'request.json'));}catch{continue;}
    if(consult){
      running.add(id);
      const active=reply(dir).catch(()=>console.error('Could not store consultation reply')).finally(()=>{running.delete(id);consultations.delete(active);});
      consultations.add(active);
    }else await reply(dir);
  }
  if(!await revoked(calculatorRepo))await reconcileCalculator(projects[calculatorRepo],{exchange:root});
  if(!await revoked(sandboxRepo))await reconcileSandbox(projects[sandboxRepo],{exchange:root});
  if(consultations.size)await Promise.race([...consultations,delay(1000)]);
}while(consultations.size);
