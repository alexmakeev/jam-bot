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
const projects = projectRecipes(JSON.parse(await readFile(process.argv[3], 'utf8')));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const git = async (cwd,args) => (await run('git',['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','credential.helper=!gh auth git-credential',...args],
  {cwd,timeout:60000,maxBuffer:2**20,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout.trimEnd();
const gh = async path => JSON.parse((await run('gh',['api',path],{timeout:30000,maxBuffer:2**20})).stdout);

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

async function execute(dir) {
  await regular(join(dir,'request.json'),1024*1024);
  const req=JSON.parse(await readFile(join(dir,'request.json'),'utf8'));
  if (!Object.hasOwn(projects,req.repo) || !/^[\w.-]+\/[\w.-]+$/.test(req.repo)) throw Error('Repository outside publisher scope');
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
    if(req.action==='publish' && dev===req.sha) return {sha:dev,alreadyPublished:true};
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
      sha:req.sha,name:'jam-check-'+basename(dir),approvedIssues:req.cards.map(card=>card.issue)});
    if(req.action==='publish') {
      await authorizedFiles(req);
      await queueCalculator(projects[req.repo],req);
      await queueSandbox(projects[req.repo],req);
      await git(temp,['push','--force-with-lease=refs/heads/dev:'+req.expected,'origin',req.sha+':refs/heads/dev']);
      if(!(await git(temp,['ls-remote','origin','refs/heads/dev'])).startsWith(req.sha+'\t'))throw Error('Publication requires reconciliation');
    }
    return {sha:req.sha,tests,log:log.slice(-8000)};
  } finally {await rm(temp,{recursive:true,force:true});}
}
async function reply(dir) {
  let answer;
  try{answer={ok:true,value:await execute(dir)};}catch(e){answer={ok:false,error:String(e.message).slice(-10000)};}
  await writeFile(join(dir,'answer.tmp'),JSON.stringify(answer),{mode:0o600,flag:'wx'});
  await rename(join(dir,'answer.tmp'),join(dir,'answer.json'));
}

await mkdir(root,{recursive:true});
const consultations=new Set();
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
    }catch(error){if(error.code==='ENOENT')continue;}
    if(consult && consultations.size>=4)continue;
    try{await rename(pending,join(dir,'request.json'));}catch{continue;}
    if(consult){
      const active=reply(dir).catch(()=>console.error('Could not store consultation reply')).finally(()=>consultations.delete(active));
      consultations.add(active);
    }else await reply(dir);
  }
  await reconcileCalculator(projects[calculatorRepo]);
  await reconcileSandbox(projects[sandboxRepo]);
  if(consultations.size)await Promise.race([...consultations,delay(1000)]);
}while(consultations.size);
