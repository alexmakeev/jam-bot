// The sum recipe builds on the publisher's successful development transaction. Each topic has independent release state.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,readdir,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {testCandidate} from './profile-recipes.mjs';
import {repositoryRoutes,selectRoute,due} from './release-routes.mjs';

const exec=promisify(execFile);
const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function save(path,value){
  const temp=path+'.'+randomUUID();
  await writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
  await rename(temp,path);
}
async function cmd(name,args,options={}){
  return (await exec(name,args,{maxBuffer:1024*1024,timeout:90000,...options})).stdout.trimEnd();
}
const git=(cwd,...args)=>cmd('git',['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','credential.helper=!gh auth git-credential',...args],{cwd});
const browserProbe=`
  const {chromium}=require('/smoke/node_modules/playwright-core');
  const assert=require('node:assert/strict');
  (async()=>{
    const browser=await chromium.launch({args:['--disable-dev-shm-usage']});
    try{
      const page=await browser.newPage();const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      const response=await page.goto('http://127.0.0.1:8080/');
      assert.equal(response.status(),200);await page.locator('#values').fill('2, 3, 5');
      await page.locator('#values').press('Enter');
      await page.waitForFunction(()=>document.querySelector('#running-totals')?.children.length===3);
      assert.deepEqual(await page.locator('#running-totals > li').allTextContents(),['2','5','10']);
      assert.match(await page.locator('#total').innerText(),/10/);assert.deepEqual(errors,[]);
      console.log('Live Chromium: HTTP 200; 2, 3, 5 produced 2, 5, 10; total 10; no page errors.');
    }finally{await browser.close();}
  })().catch(e=>{console.error(e.message);process.exitCode=1;});
`;

async function sumLive(project,job,port){
  const url='http://127.0.0.1:'+port+'/';
  const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
  const htmlDigest=createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  if(!response.ok||htmlDigest!==job.htmlDigest)throw Error('Live nightly differs from tested HTML');
  const rows=await cmd('docker',['ps','--no-trunc','--format','{{.ID}} {{.Ports}}']);
  const id=rows.split('\n').find(line=>line.includes('127.0.0.1:'+port+'->8080/tcp'))?.split(' ')[0];
  if(!/^[a-f0-9]{64}$/.test(id??'')||await cmd('docker',['inspect','--format','{{.Image}} {{.State.Health.Status}}',id])!==job.image+' healthy')throw Error('Nightly container or image identity mismatch');
  const report=await cmd('docker',['run','--rm','--network','container:'+id,'--read-only','--cap-drop','ALL','--user','1000:1000','--security-opt','no-new-privileges','--pids-limit','128','--memory','768m','--tmpfs','/tmp:rw,nosuid,nodev,size=128m','-e','HOME=/tmp','--entrypoint','node',project.sumBrowserImage,'-e',browserProbe]);
  return {url,htmlDigest,report,screenshots:[]};
}

export async function reconcileNightlySites(projects,{management,checkedSite,managementCall}){
  for(const [repo,project] of Object.entries(projects)){
    const policy=project.releaseProfile;
    if(policy?.recipe!=='sum-nightly')continue;
    if(repo!=='alexmakeev/jam-bot-sandbox'||policy.repoId!==1457276329||!project.sumBrowserImage)throw Error('Unsupported nightly recipe registration');
    const folder=join(management,'release-routes',String(policy.repoId));await mkdir(folder,{recursive:true,mode:0o700});
    const lock=new DatabaseSync(join(folder,'writer.sqlite'));lock.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try{
      const queue=join(management,'sum-dev-queue'),all=[];
      for(const file of await readdir(queue)){
        if(!/^[a-f0-9]{40}\.json$/.test(file))continue;
        const job=await json(join(queue,file));
        if(job.revision+'.json'===file&&job.done==='deployed'&&job.verifiedAt>0&&/^sha256:[0-9a-f]{64}$/.test(job.image))all.push(job);
      }
      const job=all.sort((a,b)=>b.verifiedAt-a.verifiedAt)[0];if(!job)continue;
      const file=join(folder,job.revision+'.json');
      let record=await json(file).catch(e=>{if(e.code!=='ENOENT')throw e;return {};});
      if(record.completedAt)continue;
      const profile=await repositoryRoutes(repo,policy),route=selectRoute(profile.routes,policy,'nightly');
      if(!due(route,{sourceReadyAt:job.verifiedAt}))continue;
      if(!route.source.startsWith('branch:')||route.acceptanceMinutes!==0)throw Error('Direct nightly requires a branch and immediate availability');
      const endpoint=policy.environments[route.destination];
      if(!Number.isSafeInteger(endpoint?.port)||endpoint.tier!=='development')throw Error('Invalid direct nightly destination');
      const destination={...endpoint,name:route.destination,repoId:policy.repoId,source:'https://github.com/'+repo};
      const temp=await mkdtemp(join(tmpdir(),'jam-sum-nightly-'));
      try{
        const branch=route.source.slice(7),sourceRef='refs/heads/'+branch;
        await git(temp,'init','-q');await git(temp,'remote','add','origin',destination.source+'.git');await git(temp,'fetch','--depth=1','--no-tags','origin',sourceRef);
        if(await git(temp,'rev-parse','FETCH_HEAD')!==job.revision)continue;
        await git(temp,'checkout','--detach',job.revision);
        if(record.route && JSON.stringify(record.route)!==JSON.stringify(route))throw Error('Nightly policy changed during rollout');
        record={...record,profileRevision:profile.revision,route,revision:job.revision,image:job.image};
        const files=(await git(temp,'ls-files','-z')).split('\0').filter(Boolean);
        const tests=await testCandidate({project,tree:temp,files,sha:job.revision,base:job.base,name:'jam-sum-nightly-'+job.revision.slice(0,12),approvedIssues:job.issues??[]});
        job.htmlDigest=createHash('sha256').update(await readFile(join(temp,'web/index.html'))).digest('hex');
        const registry=join(management,'repo-'+policy.repoId+'-releases.json');
        const releases=await json(registry).catch(e=>{if(e.code!=='ENOENT')throw e;return {};});
        if(releases[job.revision]&&releases[job.revision]!==job.image)throw Error('Nightly image differs from registered image');
        releases[job.revision]=job.image;await save(registry,releases);
        if((await git(temp,'ls-remote','origin',sourceRef)).split(/\s+/)[0]!==job.revision)continue;
        record.tests=tests.log;await save(file,record);
        record.live=await checkedSite(project,destination,job,record,()=>save(file,record),managementCall,sumLive);
        record.completedAt=Date.now();await save(file,record);
      }finally{await rm(temp,{recursive:true,force:true});}
    }finally{lock.close();}
  }
}
