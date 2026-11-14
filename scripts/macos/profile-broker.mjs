// Local dev publisher for explicitly selected repositories. The service only exchanges Git bundles.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, realpath, lstat, rename, rm, writeFile, mkdtemp, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const root = await realpath(process.argv[2]);
const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const git = async (cwd,args) => (await run('git',['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','credential.helper=!gh auth git-credential',...args],
  {cwd,timeout:60000,maxBuffer:2**20,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout.trimEnd();
const gh = async path => JSON.parse((await run('gh',['api',path],{timeout:30000,maxBuffer:2**20})).stdout);

async function regular(path,limit) {
  const st=await lstat(path);
  if (!st.isFile() || st.nlink!==1 || st.size>limit) throw Error('Invalid broker input file');
}
async function execute(dir) {
  await regular(join(dir,'request.json'),65536);
  const req=JSON.parse(await readFile(join(dir,'request.json'),'utf8'));
  if (!config.repositories.includes(req.repo) || !/^[\w.-]+\/[\w.-]+$/.test(req.repo)) throw Error('Repository outside publisher scope');
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
    if (!Array.isArray(req.cards)||req.cards.length<1||req.cards.length>15) throw Error('Invalid work cards');
    const files=new Set();
    const approvals=[];
    for(const card of req.cards){
      if(!Number.isSafeInteger(card.issue)||card.issue<1) throw Error('Invalid issue');
      const issue=await gh('repos/'+req.repo+'/issues/'+card.issue);
      if(!issue.locked||issue.state!=='open'||issue.pull_request||issue.user?.login?.toLowerCase()!==req.repo.split('/')[0].toLowerCase())throw Error('Work card requires an open locked repository-owner approval');
      const match=issue.body?.match(/^I approve this Leo Developer work card\.\n\nClass: development\nFiles: ([^\n]+)\n\n/);
      if(!match)throw Error('Invalid approved work card');
      approvals.push({issue:card.issue,author:issue.user.id,body:issue.body});
      for(const file of match[1].split(', ')){
        if(!file.split('/').every(part=>/^[a-zA-Z0-9_+-][a-zA-Z0-9_.+-]*$/.test(part)))throw Error('Invalid approved path');
        files.add(file);
      }
    }
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
    const tests=(await git(tree,['ls-files','-z'])).split('\0').filter(file=>/^tests\/.*\.test\.[cm]?[jt]s$/.test(file));
    if(!tests.length)throw Error('No tests found for the configured Node test recipe');
    const name='jam-check-'+basename(dir);
    let log;
    try {
      const result=await run('docker',['run','--rm','--name',name,'--network','none','--read-only','--cap-drop','ALL',
        '--security-opt','no-new-privileges','--pids-limit','100','--memory','384m','--cpus','1','--tmpfs','/tmp:rw,noexec,nosuid,size=32m',
        '--mount','type=bind,src='+tree+',dst=/code,readonly','-w','/code','--entrypoint','node',config.image,
        '--experimental-strip-types','--test','--test-concurrency=1',...tests],
        {timeout:60000,maxBuffer:256*1024});
      const version=(await run('docker',['run','--rm','--network','none','--read-only','--entrypoint','node',config.image,'--version'])).stdout.trim();
      log='Node '+version+'\nCommand: node --experimental-strip-types --test --test-concurrency=1 '+tests.join(' ')+'\nExit code: 0\nRevision: '+req.sha+'\n'+result.stdout;
    } catch(error) {throw Error(String(error.stdout||error.message).slice(-8000));}
    finally {await run('docker',['rm','-f',name]).catch(()=>{});}
    if(req.action==='publish') {
      for(const approved of approvals) {
        const current=await gh('repos/'+req.repo+'/issues/'+approved.issue);
        if(!current.locked || current.state!=='open' || current.user.id!==approved.author || current.body!==approved.body)
          throw Error('Work card changed during candidate testing');
      }
      await git(temp,['push','--force-with-lease=refs/heads/dev:'+req.expected,'origin',req.sha+':refs/heads/dev']);
      if(!(await git(temp,['ls-remote','origin','refs/heads/dev'])).startsWith(req.sha+'\t'))throw Error('Publication requires reconciliation');
    }
    return {sha:req.sha,tests,log:log.slice(-8000)};
  } finally {await rm(temp,{recursive:true,force:true});}
}
await mkdir(root,{recursive:true});
for(const id of await readdir(root)){
  if(!/^[a-f0-9-]{36}$/.test(id))continue;
  const dir=join(root,id);
  if((await realpath(dir))!==dir)continue;
  const pending=join(dir,'request.ready');
  try {await rename(pending,join(dir,'request.json'));}catch{continue;}
  let reply;try{reply={ok:true,value:await execute(dir)};}catch(e){reply={ok:false,error:String(e.message).slice(-10000)};}
  await writeFile(join(dir,'answer.tmp'),JSON.stringify(reply),{mode:0o600,flag:'wx'});
  await rename(join(dir,'answer.tmp'),join(dir,'answer.json'));
}
