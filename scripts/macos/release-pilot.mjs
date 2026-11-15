// Operator-owned concrete release recipe for the isolated local Test calculator.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {repositoryRoutes,selectRoute,due} from './release-routes.mjs';
import {reconcileNightlySites} from './nightly-sites.mjs';
import {testCandidate,verifyDeployedSvg} from './profile-recipes.mjs';

const exec=promisify(execFile), repo='alexmakeev/jam-bot-test',repoId=1457276291;
const management=join(homedir(),'.jam-bot','management'),dir=join(management,'calculator-release-pilot');
const source='https://github.com/'+repo,remote=source+'.git';

const gitEnv={...process.env,GIT_TERMINAL_PROMPT:'0'};
const shaRe=/^[a-f0-9]{40}$/;
const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function save(file,obj){const tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(obj,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(tmp,file);}
const missing=e=>e.code==='ENOENT';
async function command(bin,args,options={}){return (await exec(bin,args,{maxBuffer:8*1024*1024,timeout:120000,...options})).stdout.trimEnd();}
const gh=async path=>JSON.parse(await command('gh',['api','--hostname','github.com','repos/'+repo+path]));
const git=(cwd,...args)=>command('git',['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','credential.helper=!gh auth git-credential',...args],{cwd,env:gitEnv});
async function ref(cwd,name){return (await git(cwd,'ls-remote','origin',name)).split(/\s+/)[0]||null;}
async function managementCall(project,destination,method,revision){
  const args={repoId:destination.repoId??repoId,environment:destination.name,...(revision?{revision}:{})};
  return JSON.parse(await command(project.managementNode??process.execPath,[join(management,'client','management-cli.js'),'route',destination.source??source,'environment_'+method,JSON.stringify(args)]));
}
export function approvalText(sha){return 'Approve JAM-Bot stable release of '+repo+' at '+sha+'.';}
export function verifyApproval({sha,issue,comment,repository,permission,acceptedAt,readyAt,now=Date.now()}){
  if(!shaRe.test(sha)||!Number.isSafeInteger(issue)||!Number.isFinite(acceptedAt)||!Number.isFinite(readyAt)||readyAt<acceptedAt||now<readyAt)throw Error('RC acceptance window has not completed');
  const when=Date.parse(comment.created_at),actor=comment.user,owner=repository.owner;
  if(comment.body!==approvalText(sha)||comment.issue_url!=='https://api.github.com/repos/'+repo+'/issues/'+issue||
    !Number.isFinite(when)||when<readyAt||when>now||comment.created_at!==comment.updated_at||
    comment.performed_via_github_app||!Number.isSafeInteger(actor?.id)||actor.type!=='User'||
    repository.id!==repoId||permission.user?.id!==actor.id||permission.user?.type!=='User')throw Error('Stable requires an original human approval of this accepted SHA on the source issue');
  if(!(owner?.type==='User' && owner.id===actor.id && permission.role_name==='admin') &&
    !(owner?.type==='Organization' && ['maintain','admin'].includes(permission.role_name)))throw Error('Stable approver is not a current owner or maintainer');
}
export async function checkedSite(project,destination,job,rc,checkpoint,call=managementCall,verify=verifyDeployedSvg){
  const definition=await call(project,destination,'get');
  if(definition.tier!==(destination.tier??'staging')||definition.settings.endpoint?.address!=='127.0.0.1'||definition.settings.endpoint.port!==destination.port||definition.settings.secretRefs.length)throw Error('Release target is outside the isolated pilot');
  const status=await call(project,destination,'status');
  const healthy=(s,r,i)=>s.healthy && s.running && s.revision===r && s.image===i && s.endpoint?.address==='127.0.0.1' && s.endpoint.port===destination.port;
  rc.previous??={};
  if(!Object.hasOwn(rc.previous,destination.name)){
    if(status.running && !status.healthy)throw Error('Existing destination requires reconciliation before release');
    rc.previous[destination.name]=status.running?{revision:status.revision,image:status.image}:null;
    await checkpoint();
  }
  const previous=rc.previous[destination.name];
  if(status.running && !healthy(status,job.revision,job.image) && !(previous && healthy(status,previous.revision,previous.image)))throw Error('Destination changed since release checkpoint');
  try{
    let active=status;
    if(!healthy(active,job.revision,job.image))active=await call(project,destination,'deploy',job.revision);
    if(!healthy(active,job.revision,job.image))throw Error('Deployment returned a different revision or failed health');
    const proof=await verify(project,job,destination.port);
    return {url:proof.url,image:job.image,revision:job.revision,htmlDigest:proof.htmlDigest,screenshots:proof.screenshots,report:proof.report};
  }catch(error){
    const live=await call(project,destination,'status');
    if(live.running && live.revision!==job.revision && !(previous && healthy(live,previous.revision,previous.image)))throw Error('Destination changed during release; rollback requires reconciliation',{cause:error});
    if(previous && previous.revision!==job.revision && !healthy(live,previous.revision,previous.image)){
      const restored=await call(project,destination,'deploy',previous.revision);
      if(!healthy(restored,previous.revision,previous.image))throw Error('Local release rollback requires reconciliation',{cause:error});
    }else if(!previous && live.running){
      await call(project,destination,'stop');
      if((await call(project,destination,'status')).running)throw Error('Failed first release still running',{cause:error});
    }
    throw error;
  }
}
async function issueResult(issues,key,summary,markdown){
  // Resolve issue ownership inside the receiver. No operator credential or repository content enters its command line.
  const script=`import{readFile}from'node:fs/promises';import{recordProgress}from'/opt/jam-bot/dist/src/work-progress.js';
    let raw='';for await(const chunk of process.stdin)raw+=chunk;
    const {issues,sha,key,summary,markdown}=JSON.parse(raw),state=process.env.JAM_STATE_DIR;
    if(process.env.JAM_REPOSITORY!=='alexmakeev/jam-bot-test')throw Error('Wrong primary repository');
    for(const issue of issues){const result=JSON.parse(await readFile(state+'/assignments/'+issue+'/result.json','utf8'));
      if(result.issue!==issue||result.dev!==sha)throw Error('Issue acceptance differs from release');
      recordProgress(state,issue,key,summary,{purpose:'tests',markdown});}`;
  const sha=key.split(':').at(-1);
  await new Promise((resolve,reject)=>{
    const child=spawn('docker',['exec','-i','jam-bot-service-receiver-1','node','--input-type=module','-e',script],{stdio:['pipe','ignore','pipe']});
    let err='';child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Could not queue release outcome: '+err.slice(-1000))));child.stdin.end(JSON.stringify({issues,sha,key,summary,markdown}));
  });
}
async function githubRelease(cwd,tag,sha,prerelease,notes){
  if(await ref(cwd,'refs/tags/'+tag)!==sha)throw Error('Release tag does not name the tested revision');
  let existing;
  try{existing=await gh('/releases/tags/'+tag);}catch(e){if(!String(e.stderr).includes('HTTP 404'))throw e;}
  if(!existing){
    const file=join(cwd,'release-notes.md');await writeFile(file,notes);
    await command('gh',['release','create',tag,'--repo',repo,'--verify-tag','--target',sha,'--title',(prerelease?'Nightly RC ':'Stable ')+sha.slice(0,12),'--notes-file',file,...(prerelease?['--prerelease','--latest=false']:['--latest'])]);
    existing=await gh('/releases/tags/'+tag);
  }
  if(existing.draft || existing.tag_name!==tag || existing.prerelease!==prerelease)throw Error('Existing release metadata conflicts with this channel');
  return {url:existing.html_url,id:existing.id,tag};
}
async function run(phase,sha,commentId){
  if(!shaRe.test(sha)||!['rc','stable'].includes(phase))throw Error('Usage: release-pilot.mjs rc SHA | stable SHA APPROVAL_COMMENT_ID');
  if(phase==='stable' && (!/^\d+$/.test(commentId??'')||!Number.isSafeInteger(Number(commentId))))throw Error('Stable requires the GitHub ID of the owner or maintainer approval comment');
  await mkdir(dir,{recursive:true,mode:0o700});
  const lock=new DatabaseSync(join(dir,'writer.sqlite'));lock.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  const tmp=await mkdtemp(join(tmpdir(),'jam-nightly-'));
  try{
    const project=(await json(join(homedir(),'Library/Application Support/JAM-Bot/profile-broker/config.json'))).projects[repo];
    const profile=await repositoryRoutes(repo,project.releaseProfile);
    const nightly=selectRoute(profile.routes,project.releaseProfile,'nightly'),candidate=selectRoute(profile.routes,project.releaseProfile,'rc');
    const stable=selectRoute(profile.routes,project.releaseProfile,'stable');
    if(!nightly.source.startsWith('branch:')||candidate.source!=='channel:nightly'||stable.source!=='channel:rc'||stable.trigger!=='approval'||stable.acceptanceMinutes!==0)throw Error('Invalid channel sequence for the calculator recipe');
    const destination=route=>({name:route.destination,...project.releaseProfile.environments[route.destination]});
    const stage=destination(nightly),pilot=destination(candidate);
    const sourceBranch=nightly.source.slice('branch:'.length),mainBranch=project.releaseProfile.promotionBranch;
    if(!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,63}$/.test(mainBranch)||sourceBranch===mainBranch)throw Error('Invalid promotion branch');
    if(stable.destination!=='none')throw Error('Test stable recipe only changes release maturity');
    const job=await json(join(management,'calculator-dev-queue',sha+'.json'));
    if(job.revision!==sha || job.done!=='deployed' || job.acceptance!=='passed' || !job.issues?.length || !/^sha256:[a-f0-9]{64}$/.test(job.image))throw Error('Missing verified dev release evidence for this revision');
    if((await gh('')).id!==repoId)throw Error('Unexpected GitHub repository');
    const site=await json(join(management,'calculator-dev-evidence',sha,'deployed-19853','report.json'));
    if(site.sha!==sha || site.htmlDigest!==job.evidence?.htmlDigest)throw Error('Local acceptance does not match the dev deployment');
    const file=join(dir,sha+'.json');
    let rc=await json(file).catch(e=>{if(!missing(e))throw e;return null;});
    if(phase==='stable' && !rc?.acceptedAt)throw Error('Stable requires a published and tested RC');
    await git(tmp,'init','-q');await git(tmp,'remote','add','origin',remote);
    await git(tmp,'fetch','--no-tags','origin','refs/heads/'+sourceBranch+':refs/remotes/origin/dev','refs/heads/'+mainBranch+':refs/remotes/origin/main');
    await git(tmp,'merge-base','--is-ancestor',sha,'refs/remotes/origin/dev');
    const main=await ref(tmp,'refs/heads/'+mainBranch);
    if(!rc){
      if(!due(nightly,{sourceReadyAt:job.verifiedAt}))throw Error('Release trigger is not due');
      for(const name of await readdir(dir)){
        if(/^[0-9a-f]{40}\.json$/.test(name) && !(await json(join(dir,name))).stable)throw Error('Another RC is awaiting exact human acceptance');
      }
      await git(tmp,'merge-base','--is-ancestor',main,sha);
      rc={revision:sha,image:job.image,issues:job.issues,expectedMain:main,tag:'nightly-'+new Date().toISOString().slice(0,10)+'-'+sha.slice(0,12)};
      await save(file,rc);
    }
    const plan={sourceBranch,mainBranch,stage:stage.name,pilot:pilot.name,nightly,candidate,stable};
    if(rc.plan && JSON.stringify(rc.plan)!==JSON.stringify(plan))throw Error('RC route changed during acceptance; reconcile before promotion');
    if(!rc.plan){
      if(rc.pilot && (rc.pilot.url!=='http://127.0.0.1:'+pilot.port+'/'||rc.staging.url!=='http://127.0.0.1:'+stage.port+'/'||rc.readyAt-rc.acceptedAt!==candidate.acceptanceMinutes*60000))throw Error('Recorded RC differs from adopted release profile');
      rc.plan=plan;rc.profileRevision=profile.revision;await save(file,rc);
    }
    if(rc.image!==job.image || rc.revision!==sha)throw Error('Release inputs changed');
    const notes='# Release verification\n\nRepository `'+repo+'`. Revision `'+sha+'`. Image `'+job.image+'`. Originating tasks '+rc.issues.map(i=>'#'+i).join(', ')+'.\n';
    if(phase==='rc'){
      if(!rc.staging){
        await git(tmp,'checkout','--detach',sha);
        const files=(await git(tmp,'ls-files','-z')).split('\0').filter(Boolean);
        const tests=await testCandidate({project,tree:tmp,files,sha,base:job.base,name:'jam-release-'+sha.slice(0,12),approvedIssues:job.issues});
        // Only a previously verified dev image can enter these two host-registered local staging recipes.
        const indexFile=join(management,'calculator-pilot-images.json');
        const index=await json(indexFile).catch(e=>{if(!missing(e))throw e;return {};});
        if(index[sha] && index[sha]!==job.image)throw Error('Release image already registered at another digest');
        index[sha]=job.image;await save(indexFile,index);
        const routedIndex=join(management,'repo-'+repoId+'-releases.json');
        const routed=await json(routedIndex).catch(e=>{if(!missing(e))throw e;return {};});
        if(routed[sha] && routed[sha]!==job.image)throw Error('Routed image differs from registered release');
        routed[sha]=job.image;await save(routedIndex,routed);
        rc.tests=tests.log;rc.staging=await checkedSite(project,stage,job,rc,()=>save(file,rc));await save(file,rc);
      }
      const tagHead=await ref(tmp,'refs/tags/'+rc.tag);
      if(main!==sha || tagHead!==sha){
        if(main!==rc.expectedMain || tagHead)throw Error('main or the nightly tag changed; promotion requires reconciliation');
        await git(tmp,'push','--atomic','--force-with-lease=refs/heads/'+mainBranch+':'+rc.expectedMain,
          '--force-with-lease=refs/tags/'+rc.tag+':','origin',sha+':refs/heads/'+mainBranch,sha+':refs/tags/'+rc.tag);
      }
      if(await ref(tmp,'refs/heads/'+mainBranch)!==sha)throw Error('main no longer matches the tested RC');
      rc.nightly=await githubRelease(tmp,rc.tag,sha,true,notes+'\nThe full unit and browser suites passed in isolated staging. This prerelease awaits owner or maintainer acceptance.');
      await save(file,rc);
      if(!rc.acceptedAt){
        rc.nightlyAt??=Date.now();await save(file,rc);
        if(!due(candidate,{sourceReadyAt:rc.nightlyAt+nightly.acceptanceMinutes*60000}))throw Error('Candidate awaits its configured trigger or acceptance period');
        rc.pilot=await checkedSite(project,pilot,job,rc,()=>save(file,rc));
        rc.acceptedAt=Date.now();rc.readyAt=rc.acceptedAt+candidate.acceptanceMinutes*60000;
        await save(file,rc);
      }
      const report=notes+'\nPrevious main `'+rc.expectedMain+'`. Nightly '+rc.nightly.url+'.\n\nStaging '+rc.staging.url+' and local production-like '+rc.pilot.url+' served HTML SHA-256 `'+rc.pilot.htmlDigest+'`.\n\n'+rc.tests+'\n\nEarliest stable acceptance '+new Date(rc.readyAt).toISOString()+'.';
      await issueResult(rc.issues,'release:rc:'+sha,'The integrator promoted tested commit `'+sha+'` to [nightly RC]('+rc.nightly.url+'). The isolated local production-like site passed browser checks. Stable acceptance is pending.',report);
      rc.reportedAt=Date.now();await save(file,rc);
      return {release:rc.nightly.url,sha,image:rc.image,staging:rc.staging.url,pilot:rc.pilot.url,eligibleAt:new Date(rc.readyAt).toISOString(),approval:approvalText(sha)};
    }
    if(main!==sha || await ref(tmp,'refs/tags/'+rc.tag)!==sha)throw Error('RC moved; a changed build requires new acceptance');
    const current=await gh('/issues/comments/'+commentId);const issue=Number(current.issue_url?.split('/').at(-1));
    if(!rc.issues.includes(issue) || current.id!==Number(commentId) || !/^[a-z\d-]+$/i.test(current.user?.login??''))throw Error('Stable approval is outside the original RC work cards');
    const repository=await gh(''),permission=await gh('/collaborators/'+encodeURIComponent(current.user.login)+'/permission');
    verifyApproval({sha,issue,comment:current,repository,permission,acceptedAt:rc.acceptedAt,readyAt:rc.readyAt});
    // Stable is a maturity decision. The isolated deployment must still serve the accepted image.
    const live=await managementCall(project,pilot,'status');
    if(!live.healthy || !live.running || live.image!==job.image || live.revision!==sha)throw Error('Pilot changed since RC acceptance');
    await verifyDeployedSvg(project,job,pilot.port);
    verifyApproval({sha,issue,comment:await gh('/issues/comments/'+commentId),repository:await gh(''),permission:await gh('/collaborators/'+encodeURIComponent(current.user.login)+'/permission'),acceptedAt:rc.acceptedAt,readyAt:rc.readyAt});
    if(await ref(tmp,'refs/heads/'+mainBranch)!==sha || await ref(tmp,'refs/tags/'+rc.tag)!==sha)throw Error('Accepted build changed during final checks');
    const tag='stable-'+sha.slice(0,12),tagHead=await ref(tmp,'refs/tags/'+tag);
    if(tagHead && tagHead!==sha)throw Error('Stable tag already points to another revision');
    if(!tagHead)await git(tmp,'push','--force-with-lease=refs/tags/'+tag+':','origin',sha+':refs/tags/'+tag);
    if(await ref(tmp,'refs/heads/'+mainBranch)!==sha)throw Error('Accepted main changed before stable publication');
    rc.stable=await githubRelease(tmp,tag,sha,false,notes+'\nApproved by '+current.user.login+' on '+current.html_url+'.');
    rc.approvalId=current.id;await save(file,rc);
    await issueResult(rc.issues,'release:stable:'+sha,'The release owner approved `'+sha+'`. The integrator published [stable]('+rc.stable.url+') after verifying the same local pilot image.',notes+'\nHuman approval '+current.html_url+'.\nStable '+rc.stable.url+'.');
    return {release:rc.stable.url,sha,approval:current.html_url};
  }finally{lock.close();await rm(tmp,{recursive:true,force:true});}
}
// A project can hold one RC while development proceeds on later tasks.
async function reconcile(){
  const config=await json(join(dir,'config.json'));
  if(config.automatic!==true)return;
  const projects=(await json(join(homedir(),'Library/Application Support/JAM-Bot/profile-broker/config.json'))).projects;
  const results=await Promise.allSettled([reconcileNightlySites(projects,{management,checkedSite,managementCall}),reconcileCandidates()]);
  const failed=results.filter(result=>result.status==='rejected');
  if(failed.length)throw Error(failed.map(result=>result.reason.message).join('; '));
}
async function reconcileCandidates(){
  const records=[];
  for(const file of await readdir(dir)){
    if(/^[0-9a-f]{40}\.json$/.test(file))records.push(await json(join(dir,file)));
  }
  const held=records.find(record=>!record.stable);
  if(held){
    if(!held.reportedAt)return run('rc',held.revision);
    const inbox=join(homedir(),'.jam-bot','profile-exchange','release-approvals',String(repoId));
    const files=await readdir(inbox).catch(e=>{if(!missing(e))throw e;return [];});
    for(const file of files){
      if(!/^[1-9]\d{0,19}\.json$/.test(file))continue;
      const hint=await json(join(inbox,file));
      if(hint.repoId!==repoId||hint.sha!==held.revision||!held.issues.includes(hint.issue)||String(hint.commentId)+'.json'!==file)continue;
      if(held.readyAt>Date.now())return;
      try{return await run('stable',held.revision,String(hint.commentId));}
      catch(error){
        if(!/original human approval|not a current owner or maintainer|outside the original RC work cards/.test(error.message))throw error;
        await rename(join(inbox,file),join(inbox,file+'.rejected'));
      }
    }
    return;
  }
  const queue=join(management,'calculator-dev-queue');
  const jobs=[];
  for(const file of await readdir(queue)){
    if(!/^[0-9a-f]{40}\.json$/.test(file))continue;
    const job=await json(join(queue,file));
    if(job.done==='deployed' && job.acceptance==='passed' && !records.some(record=>record.revision===job.revision))jobs.push(job);
  }
  if(jobs.length){
    jobs.sort((a,b)=>b.verifiedAt-a.verifiedAt);
    if(jobs[0].verifiedAt>Math.max(0,...records.map(record=>record.acceptedAt??0)))return run('rc',jobs[0].revision);
  }
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]){
  const action=process.argv[2]==='reconcile'?reconcile():run(...process.argv.slice(2));
  action.then(result=>{if(result)console.log(JSON.stringify(result,null,2));}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
