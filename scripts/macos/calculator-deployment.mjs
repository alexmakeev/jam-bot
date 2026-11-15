// This host-only recipe belongs to one development site. Issue content cannot select a destination or build command.
import {verifyDeployedSvg} from './profile-recipes.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,mkdtemp,readdir,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';

const exec=promisify(execFile);
export const calculatorRepo='alexmakeev/jam-bot-test';
export const sandboxRepo='alexmakeev/jam-bot-sandbox';
const commit=/^[0-9a-f]{40}$/, dockerId=/^sha256:[0-9a-f]{64}$/;
const management=join(homedir(),'.jam-bot','management');

const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function atomic(file,obj){
  const tmp=file+'.'+randomUUID()+'.tmp';
  await writeFile(tmp,JSON.stringify(obj)+'\n',{mode:0o600,flag:'wx'});
  await rename(tmp,file);
}
// Fixed development recipes bind a GitHub identity to its module, endpoint and private release index.
function developmentSite({repo,repoId,environment,port,moduleName,enabled}){
  const stateDir=join(management,environment+'-dev-queue');
  async function queueCalculator(project,req,dir=stateDir){
    if(req.repo!==repo||project[enabled]!==true||req.action!=='publish')return;
    if(!commit.test(req.sha)||!commit.test(req.expected)||req.sha===req.expected)throw Error('Invalid development publication');
    await mkdir(dir,{mode:0o700,recursive:true});
    const file=join(dir,req.sha+'.json');
    // The publisher is the sole queue writer. Its service lock serializes publication and deployment.
    try{await json(file);return;}catch(e){if(e.code!=='ENOENT')throw e;}
    const issues=req.cards?.map(card=>card.issue)??[];
    if(issues.some(id=>!Number.isSafeInteger(id)||id<1)||issues.length>15)throw Error('Invalid deployment work cards');
    await atomic(file,{revision:req.sha,base:req.expected,issues,acceptSvg:repo===calculatorRepo && issues.includes(project.calculatorSpecCards?.staticSvg),attempts:0,queuedAt:Date.now()});
  }
  async function command(file,args,opts={}){
    return (await exec(file,args,{timeout:90000,maxBuffer:4*1024*1024,...opts})).stdout;
  }
  const remote='https://github.com/'+repo+'.git';
  const git=(args,cwd)=>command('git',['-c','credential.helper=','-c','credential.helper=!gh auth git-credential','-c','core.hooksPath=/dev/null',...args],{cwd});
  const head=async()=>JSON.parse(await command('gh',['api','repos/'+repo+'/git/ref/heads/dev'])).object.sha;
  async function manage(project,action,revision){
    const args={repoId,environment,...(revision?{revision}:{})};
    return JSON.parse(await command(project.managementNode??process.execPath,[join(management,'client','management-cli.js'),'route',remote.slice(0,-4),'environment_'+action,JSON.stringify(args)]));
  }
  function verifiedSite(status,rev,image){
    return status.healthy===true&&status.running===true&&status.revision===rev&&status.image===image&&status.endpoint?.address==='127.0.0.1'&&status.endpoint.port===port;
  }
  async function buildCalculator(rev,project){
    if(!commit.test(rev)||!dockerId.test(project.image)||!dockerId.test(project.calculatorRuntimeImage))throw Error('Invalid pinned development site build inputs');
    const temp=await mkdtemp(join(tmpdir(),'jam-calculator-'));
    try{
      await git(['init','--bare','-q'],temp);
      await git(['fetch','--no-tags','--depth=1',remote,'refs/heads/dev'],temp);
      if((await git(['rev-parse','FETCH_HEAD'],temp)).trim()!==rev)throw Error('Published development revision changed');
      const src=join(temp,'inputs'),out=join(temp,'image');
      await mkdir(src);await mkdir(out);
      // Project Dockerfiles, package hooks, tests and symlinks cannot enter the build context.
      for(const [path,dest] of [['src/'+moduleName+'.ts',join(src,moduleName+'.ts')],['web/index.html',join(out,'index.html')],['web/server.mjs',join(out,'server.mjs')]]){
        const entry=(await git(['ls-tree',rev,'--',path],temp)).trim().split(/\s+/);
        if(entry[0]!=='100644'||entry[1]!=='blob'||entry[3]!==path)throw Error('Missing regular site source '+path);
        const bytes=await command('git',['cat-file','blob',entry[2]],{cwd:temp,encoding:'buffer',maxBuffer:1024*1024});
        await writeFile(dest,bytes);
      }
      const compiled=await command('docker',['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--pids-limit','96','--memory','384m','--cpus','1','--user','1000:1000','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--mount','type=bind,src='+src+',dst=/src,readonly',
        '--workdir','/src','--entrypoint','sh',project.image,'-ec','/opt/jam-bot/node_modules/.bin/tsc /src/'+moduleName+'.ts --strict --target ES2022 --module ES2022 --outDir /tmp/dist && cat /tmp/dist/'+moduleName+'.js'],{encoding:'buffer'});
      await writeFile(join(out,moduleName+'.js'),compiled);
      const baseTag='jam-calculator-runtime:'+project.calculatorRuntimeImage.slice(7);
      await command('docker',['tag',project.calculatorRuntimeImage,baseTag]);
      if((await command('docker',['image','inspect','--format','{{.Id}}',baseTag])).trim()!==project.calculatorRuntimeImage)throw Error('Calculator runtime image changed');
      await writeFile(join(out,'Dockerfile'),'FROM '+baseTag+'\nWORKDIR /calculator\nCOPY index.html server.mjs '+moduleName+'.js ./\nUSER 65532:65532\nCMD ["node","server.mjs"]\n');
      const image=(await command('docker',['build','--pull=false','--network=none','--label','org.opencontainers.image.revision='+rev,'--quiet',out])).trim();
      if(!dockerId.test(image))throw Error('Calculator build did not return an image ID');
      return image;
    } finally {await rm(temp,{recursive:true,force:true});}
  }
  async function reconcileCalculator(project,{
    queue=stateDir,exchange,registry=join(management,environment+'-dev-releases.json'),remoteHead=head,managementCall=manage,build=buildCalculator,accept=verifyDeployedSvg,
    repositoryId=async()=>JSON.parse(await command('gh',['api','repos/'+repo])).id
  }={}){
    if(project?.[enabled]!==true)return;
    await mkdir(queue,{mode:0o700,recursive:true});
    const orders=(await readdir(queue)).filter(name=>/^[0-9a-f]{40}\.json$/.test(name));
    for(const name of orders){
      const file=join(queue,name),job=await json(file);
      if(['deployed','failed-acceptance'].includes(job.done) && job.issues?.length && exchange && !job.noticeDelivered){
        const delivery=join(exchange,'deployments',String(repoId));
        await mkdir(delivery,{recursive:true,mode:0o700});
        await atomic(join(delivery,name),{repoId,repository:repo,environment,port,issues:job.issues,
          revision:job.revision,image:job.image,verifiedAt:job.verifiedAt,acceptance:job.acceptance});
        job.noticeDelivered=true;await atomic(file,job);
      }
      if(job.done||job.after>Date.now())continue;
      try{
        if(job.revision+'.json'!==name||!commit.test(job.base))throw Error('Invalid calculator queue record');
        if(await repositoryId()!==repoId)throw Error('Calculator repository identity changed');
        if(job.acceptance==='failed'){
          if(job.previous){
            let current=await managementCall(project,'status');
            if(!verifiedSite(current,job.previous.revision,job.previous.image))current=await managementCall(project,'deploy',job.previous.revision);
            if(!verifiedSite(current,job.previous.revision,job.previous.image))throw Error('Previous site recovery pending');
          }
          job.done='failed-acceptance';await atomic(file,job);continue;
        }
        const current=await remoteHead();
        if(current!==job.revision){
          if(current===job.base&&Date.now()-job.queuedAt<24*3600*1000){job.after=Date.now()+30000;}
          else job.done='superseded';
        }else{
          const def=await managementCall(project,'get');
          if(def.tier!=='development'||def.settings.secretRefs.length||def.settings.endpoint?.port!==port||def.settings.endpoint?.address!=='127.0.0.1')throw Error('Calculator definition outside operator scope');
          let status=await managementCall(project,'status');
          if(!job.image){
            job.image=await build(job.revision,project);
            await atomic(file,job);
          }
          if(await remoteHead()!==job.revision){job.done='superseded';}
          else{
            let releases={};try{releases=await json(registry);}catch(e){if(e.code!=='ENOENT')throw e;}
            if(releases[job.revision]&&releases[job.revision]!==job.image)throw Error('Conflicting calculator image for published revision');
            releases[job.revision]=job.image;await atomic(registry,releases);
            if(job.acceptSvg && !job.previous && status.healthy && status.running && status.revision!==job.revision && commit.test(status.revision) && dockerId.test(status.image)){
              job.previous={revision:status.revision,image:status.image};await atomic(file,job);
            }
            if(!verifiedSite(status,job.revision,job.image))status=await managementCall(project,'deploy',job.revision);
            if(!verifiedSite(status,job.revision,job.image))throw Error('Calculator deployment not healthy at requested revision');
            if(job.acceptSvg){
              try{
                const evidence=await accept(project,job,port);
                job.acceptance='passed';job.evidence=evidence;
              }catch(error){
                if(!String(error.message).includes('AssertionError') && !String(error.message).includes('Live HTML does not match'))throw error;
                job.acceptance='failed';job.verifiedAt=Date.now();job.failure=String(error.message).slice(-3000);
                await atomic(file,job);
              }
            }
            if(job.acceptance==='failed'){
              if(job.previous){const restored=await managementCall(project,'deploy',job.previous.revision);
                if(!verifiedSite(restored,job.previous.revision,job.previous.image))throw Error('Previous site recovery pending');}
              job.done='failed-acceptance';
            }else{job.done='deployed';job.verifiedAt=Date.now();}
          }
        }
      }catch(e){
        job.attempts++;job.after=Date.now()+Math.min(300000,5000*2**Math.min(job.attempts,6));
        console.error('Development deployment pending',repo,job.revision,e.message.split('\n')[0].slice(0,300));
      }
      await atomic(file,job);
    }
  }

  return {queueCalculator,verifiedSite,buildCalculator,reconcileCalculator};
}
export const {queueCalculator,verifiedSite,buildCalculator,reconcileCalculator}=developmentSite({
  repo:calculatorRepo,repoId:1457276291,environment:'calculator',port:19853,moduleName:'triangular',enabled:'autoDeployCalculator'
});
export const {queueCalculator:queueSandbox,reconcileCalculator:reconcileSandbox}=developmentSite({
  repo:sandboxRepo,repoId:1457276329,environment:'sum',port:19854,moduleName:'sum',enabled:'autoDeploySum'
});
