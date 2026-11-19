// Operator-supplied profiles. No issue, patch, package script or webhook selects shell commands.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {codeFile} from './static-quality.mjs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const run=promisify(execFile);
const recipes=new Set(['node-strip','typescript-build','typescript-compiled']);
const compiledRecipe='typescript-compiled';
const ownRepository='alexmakeev/jam-bot';
const ownRecipeImage='sha256:af6518a66aeaab0353568447cc00ecff09838cf969b22d1947ed5a9a2478f3c9';
const safeRepo=/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function projectRecipes(config) {
  const projects=config.projects ?? Object.fromEntries(config.repositories.map(repo=>[repo,{image:config.image,recipe:'node-strip'}]));
  for (const [repo,project] of Object.entries(projects)) {
    if (project?.recipe===compiledRecipe && (repo!==ownRepository || project.image!==ownRecipeImage ||
        project.qualityGate!=='development-static-v1' || project.releaseProfile?.repoId!==1456661011 ||
        project.releaseProfile.profileRef!=='dev' || !Number.isSafeInteger(project.controlledIssue) || project.controlledIssue<1 ||
        project.calculatorBrowserImage || project.sumBrowserImage || project.autoDeployCalculator || project.autoDeploySum))
      throw Error('Invalid disconnected own-repository recipe scope');
    if(project?.clearTotalsCard!==undefined && (!project.sumBrowserImage || !Number.isSafeInteger(project.clearTotalsCard) || project.clearTotalsCard<1))throw Error('Invalid clear totals work card');
    if(project?.sumBrowserImage && (project.recipe!=='node-strip'||!/^sha256:[a-f0-9]{64}$/.test(project.sumBrowserImage)||!Number.isSafeInteger(project.runningTotalsCard)||project.runningTotalsCard<1))throw Error('Invalid sum page recipe');
    if (project?.calculatorSpecCards && (!project.calculatorBrowserImage || Object.entries(project.calculatorSpecCards).some(([check,issue])=>!['dragons','reset','staticSvg'].includes(check) || !Number.isSafeInteger(issue) || issue<1))) throw Error('Invalid calculator acceptance mapping');
    if (project?.calculatorBrowserImage && (project.recipe!=='typescript-build' || !/^sha256:[a-f0-9]{64}$/.test(project.calculatorBrowserImage))) throw Error('Invalid calculator browser image');
    if (!safeRepo.test(repo) || !project || !recipes.has(project.recipe) || typeof project.image!=='string' || !project.image || project.image.startsWith('-')) {
      throw Error('Invalid trusted project recipe');
    }
    if(project.qualityGate!==undefined&&project.qualityGate!=='development-static-v1')throw Error('Unknown Development quality gate');
  }
  return projects;
}

function selectedBrowserChecks(project,issues){
  const checks=Object.entries(project.calculatorSpecCards??{}).filter(([,issue])=>issues.includes(issue)).map(([check])=>check);
  if(project.sumBrowserImage&&issues.includes(project.runningTotalsCard))checks.push('runningTotals');
  if(project.sumBrowserImage&&issues.includes(project.clearTotalsCard))checks.push('clearTotals');
  return {image:project.sumBrowserImage??project.calculatorBrowserImage,site:project.sumBrowserImage?'sum':'calculator',checks};
}

export function developmentRecipe(project,issue,deployed){
  if(!project||project.qualityGate!=='development-static-v1'||!Number.isSafeInteger(issue)||issue<1)return;
  const browser=selectedBrowserChecks(project,[issue]);
  const checks=['baseline','assertion-red','worker-green','combined-green'];
  if(browser.image)checks.push('browser-'+browser.site,...browser.checks.map(name=>'browser-'+name));
  if(deployed)checks.push('deployed-svg');
  const identity=createHash('sha256').update(JSON.stringify([project.recipe,project.qualityGate,project.image,browser.image??null,checks])).digest('hex');
  return {version:1,issue,recipe:project.recipe,identity,checks};
}

const buildAndTest = `
set -eu
cp -R /code/. /workspace/
cd /workspace
node --version
if [ "$JAM_STATIC_GATE" = 1 ]; then node /gate/static-quality.mjs; fi
/opt/jam-bot/node_modules/.bin/tsc --version
rm -rf -- dist
/opt/jam-bot/node_modules/.bin/tsc -p tsconfig.json
exec node --experimental-strip-types --test --test-reporter=/gate/unit-reporter.mjs --test-concurrency=1 "$@"
`;

const compileAndTest = `
set -eu
cp -R /code/. /workspace/
cd /workspace
node --version
cmp -s package-lock.json /opt/jam-own/package-lock.json
printf "%s  %s\n" 319636c130ef3ea6abe2be13b5b11d6d972879168e12c55c8987917481974531 package.json 835ee875d71421d87bc25bdab280fd951a1f4685af8bf9bae30fa3b1056dcbd8 tsconfig.json | sha256sum --check --status
test ! -e dist && test ! -L dist
test ! -e node_modules && test ! -L node_modules
ln -s /opt/jam-own/node_modules node_modules
node /gate/static-quality.mjs
/opt/jam-bot/node_modules/.bin/tsc -p tsconfig.json
if [ "$JAM_VALIDATION_STAGE" != test-red ]; then node /gate/own-management-smoke.mjs; fi
for file in "$@"; do test -f "$file"; done
exec node --test --test-reporter=/gate/unit-reporter.mjs --test-concurrency=1 "$@"
`;

async function calculatorPreview({tree,sha,image,name,checks,site,base}) {
  const options={cwd:tree,maxBuffer:1024*1024};
  const blob=async (path,rev=sha)=>{
    const {stdout:entry}=await run('git',['ls-tree',rev,'--',path],options);
    const match=/^100644 blob ([0-9a-f]{40,64})\t/.exec(entry);
    if(!match)throw Error('Missing regular calculator input '+path);
    return (await run('git',['cat-file','blob',match[1]],options)).stdout;
  };
  const [html,source]=await Promise.all([blob('web/index.html'),blob(site==='sum'?'src/sum.ts':'src/triangular.ts')]);
  const server=site==='sum'||checks.includes('staticSvg')?await blob('web/server.mjs'):undefined;
  const baseline=site==='sum'?undefined:await blob('web/index.html',base);
  return runBrowser({html,source,server,baseline,sha,image,name,checks,site});
}

const evidenceDir=(sha,phase)=>join(homedir(),'.jam-bot','management','calculator-dev-evidence',sha,phase);

async function runBrowser({html,source,server,baseline,sha,image,name,checks,site,liveContainer,livePort}){
  if(!/^[0-9a-f]{40}$/.test(sha))throw Error('Invalid browser candidate revision');
  const deployed=Boolean(liveContainer);
  const proofs=evidenceDir(sha,deployed?'deployed-'+livePort:'candidate');
  const container=name+'-browser';
  const args=['run','--rm','-i','--name',container,'--network',liveContainer?'container:'+liveContainer:'none','--read-only','--cap-drop','ALL',
    '--label','jam-bot.validation='+container,
    '--security-opt','no-new-privileges','--pids-limit','128','--memory','768m','--cpus','1','--user','1000:1000',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=128m','-e','HOME=/tmp','-e','XDG_CACHE_HOME=/tmp/cache',image];
  try {
    const {stdout}=await new Promise((resolve,reject)=>{
      const child=execFile('docker',args,{timeout:60000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>{
        if(error)reject(Error('Calculator Chromium preview failed at '+sha+'\n'+(stdout.replace(/^JAM_SCREEN .*$/gm,'')+stderr).slice(-3000)));
        else resolve({stdout});
      });
      child.stdin.on('error',()=>{}); // A container startup failure is reported by execFile.
      child.stdin.end(JSON.stringify({sha,html,source,checks,site,server,baseline,deployed}));
    });
    if(!checks.includes('staticSvg'))return stdout;
    await mkdir(proofs,{recursive:true,mode:0o700});
    const shots=[];
    for(const match of stdout.matchAll(/^JAM_SCREEN (320|390|960|1440) ([A-Za-z0-9+/=]+)$/gm)){
      const png=Buffer.from(match[2],'base64');
      if(png.length>1024*1024 || png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Invalid browser evidence');
      await writeFile(join(proofs,match[1]+'.png'),png,{mode:0o600});shots.push(Number(match[1]));
    }
    if(new Set(shots).size!==4)throw Error('Missing required SVG screenshots');
    const log=stdout.replace(/^JAM_SCREEN .*\n/gm,'')+'Screenshots for '+sha+': 320,390,960,1440 px.\n';
    await writeFile(join(proofs,'report.json'),JSON.stringify({sha,htmlDigest:createHash('sha256').update(html).digest('hex'),shots,log}),{mode:0o600});
    return log;
  } finally {await run('docker',['rm','-f',container]).catch(()=>{});}
}

export async function testCandidate({project,tree,files,sha,base,name,approvedIssues=[],stage}) {
  const compiled=project.recipe===compiledRecipe;
  const build=compiled||project.recipe==='typescript-build';
  if(compiled&&(project.image!==ownRecipeImage||project.qualityGate!=='development-static-v1'||
      !['test-head','test-red','test','publish'].includes(stage)))throw Error('Invalid compiled validation inputs');
  if (!recipes.has(project.recipe)) throw Error('Unknown validation recipe');
  if (build && !files.includes('tsconfig.json')) throw Error('Missing tsconfig.json for typescript-build recipe');
  const matcher=compiled ? /^test\/[a-zA-Z0-9_.-]+\.test\.ts$/ : build ? /^test\/.*\.test\.[cm]?[jt]s$/ : /^tests\/.*\.test\.[cm]?[jt]s$/;
  const selection=compiled&&stage==='test-red'
    ? (await run('git',['diff','--name-only','--no-renames','-z',base,'--'],{cwd:tree})).stdout.split('\0')
    : files;
  const tests=selection.filter(file=>files.includes(file)&&matcher.test(file)).sort();
  if (!tests.length) throw Error('No tracked tests found for '+project.recipe);
  const executed=compiled ? tests.map(path=>'dist/'+path.replace(/\.ts$/,'.js')) : tests;
  const unitCommand=(compiled?'node':'node --experimental-strip-types')+' --test --test-reporter=/gate/unit-reporter.mjs --test-concurrency=1 '+executed.join(' ');
  const command=compiled ? ['sh','-c',compileAndTest,'jam-compiled',...executed] : build ? ['sh','-c',buildAndTest,'jam-build',...tests] :
    ['sh','-c','set -eu; node --version; if [ "$JAM_STATIC_GATE" = 1 ]; then node /gate/static-quality.mjs; fi; exec node --experimental-strip-types --test --test-reporter=/gate/unit-reporter.mjs --test-concurrency=1 "$@"','jam-test',...tests];
  const [entry,...argv]=command;
  const quality=await mkdtemp(join(tmpdir(),'jam-quality-'));
  try {
    const {stdout}=await run('git',['diff','--name-only','--no-renames','-z',base,'--'],{cwd:tree});
    const qualityFiles=compiled?files.filter(file=>/^(?:src\/.+\.ts|test\/.+\.test\.ts)$/.test(file)):files;
    const changed=stdout.split('\0').filter(file=>file && qualityFiles.includes(file) && codeFile(file));
    const baseline={};
    for(const file of changed){
      try {baseline[file]=(await run('git',['show',base+':'+file],{cwd:tree,maxBuffer:1024*1024})).stdout;}
      catch(error){if(!(await run('git',['ls-tree','-z',base,'--',file],{cwd:tree})).stdout)baseline[file]='';else throw error;}
    }
    await writeFile(join(quality,'unit-reporter.mjs'),await readFile(new URL('./unit-reporter.mjs',import.meta.url)),{mode:0o644});
    await writeFile(join(quality,'static-quality.mjs'),await readFile(new URL('./static-quality.mjs',import.meta.url)),{mode:0o644});
    await run('git',['-c','core.fsmonitor=false','diff-files','--quiet','--'],{cwd:tree});
    const executionTree=(await run('git',['-c','core.fsmonitor=false','write-tree'],{cwd:tree})).stdout.trim();
    const execution={stage:stage??'test',tree:executionTree,productionRevision:stage==='test-red'?base:sha,testRevision:sha};
    await writeFile(join(quality,'input.json'),JSON.stringify({recipe:project.recipe,sha,files:qualityFiles,changed,baseline,execution}),{mode:0o644});
  } catch(error){await rm(quality,{recursive:true,force:true});throw error;}
  const args=['run','--rm','--name',name,'--network','none','--read-only','--cap-drop','ALL','--user','1000:1000',
    '--label','jam-bot.validation='+name,
    '--env','JAM_STATIC_GATE='+(project.qualityGate==='development-static-v1'?'1':'0'),
    '--security-opt','no-new-privileges','--pids-limit','128','--memory',compiled?'1536m':'512m','--cpus','1','--tmpfs',compiled?'/tmp:rw,nosuid,nodev,size=96m':'/tmp:rw,noexec,nosuid,size=32m',
    '--mount','type=bind,src='+join(quality,'unit-reporter.mjs')+',dst=/gate/unit-reporter.mjs,readonly',
    '--mount','type=bind,src='+join(quality,'static-quality.mjs')+',dst=/gate/static-quality.mjs,readonly',
    '--mount','type=bind,src='+join(quality,'input.json')+',dst=/gate/input.json,readonly',
    '--mount','type=bind,src='+tree+',dst=/code,readonly','-w','/code'];
  if(compiled)args.push('--pull','never','--env','HOME=/tmp','--env','JAM_VALIDATION_STAGE='+stage,
    '--mount','type=bind,src='+fileURLToPath(new URL('./own-management-smoke.mjs',import.meta.url))+',dst=/gate/own-management-smoke.mjs,readonly');
  if (build) args.push('--tmpfs','/workspace:rw,nosuid,nodev,size='+(compiled?'160m':'96m')+',uid=1000,gid=1000,mode=700');
  try {
    const {stdout,stderr}=await run('docker',[...args,'--entrypoint',entry,project.image,...argv],{timeout:90000,maxBuffer:1024*1024});
    const log='Recipe: '+project.recipe+'\nImage: '+project.image+'\nBuild: '+(build?'tsc -p tsconfig.json':'native Node type stripping')+
      '\nCommand: '+unitCommand+'\nExit code: 0\nRevision: '+sha;
    const qualityEvidence=stdout.split('\n').filter(line=>/^(?:Quality (?:gate|results)|Unit results|Management smoke): /.test(line)).join('\n');
    const diagnostic=stdout.split('\n').filter(line=>!/^(?:Quality (?:gate|results)|Unit results|Management smoke): /.test(line)).join('\n')+(stderr?'\n'+stderr:'');
    const {image:browserImage,site,checks}=selectedBrowserChecks(project,approvedIssues);
    const preview=['test-head','test-red'].includes(stage)?'Browser acceptance: pending integrator candidate.':browserImage ? await calculatorPreview({tree,sha,base,image:browserImage,name,checks,site}) : '';
    return {tests,log:log+'\n'+qualityEvidence+'\n'+(diagnostic.length>5000 ? diagnostic.slice(0,400)+'\n…\n'+diagnostic.slice(-4600) : diagnostic)+'\n'+(browserImage&& !['test-head','test-red'].includes(stage)?'Browser recipe: calculator Chromium acceptance\nBrowser image: '+browserImage+'\nBrowser revision: '+sha+'\n':'')+preview};
  } catch (error) {
    const header='Recipe: '+project.recipe+'\nImage: '+project.image+'\nBuild: '+(build?'tsc -p tsconfig.json':'native Node type stripping')+'\nCommand: '+unitCommand+'\nExit code: '+(error.code??'unknown')+'\nRevision: '+sha+'\nProduction baseline: '+base+'\n';
    const qualityEvidence=(error.stdout??'').split('\n').filter(line=>/^(?:Quality (?:gate|results)|Unit results|Management smoke): /.test(line)).join('\n');
    throw Error('Validation failed for '+project.recipe+'\n'+header+[(error.stdout??'').split('\n').filter(line=>!/^(?:Quality (?:gate|results)|Unit results|Management smoke): /.test(line)).join('\n'),error.stderr,(!error.stdout && !error.stderr)?error.message:'',error.killed?'Timed out':''].filter(Boolean).join('\n').slice(-8000)+'\n'+qualityEvidence);
  } finally { await run('docker',['rm','-f',name]).catch(()=>{});await rm(quality,{recursive:true,force:true}); }
}

export async function verifyDeployedSvg(project,job,port){
  const expected=JSON.parse(await readFile(join(evidenceDir(job.revision,'candidate'),'report.json'),'utf8'));
  const url='http://127.0.0.1:'+port+'/';
  const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Live HTTP unavailable');
  const html=await response.text();
  if(expected.sha!==job.revision||createHash('sha256').update(html).digest('hex')!==expected.htmlDigest)throw Error('Live HTML does not match tested candidate');
  const {stdout}=await run('docker',['ps','--no-trunc','--format','{{.ID}} {{.Ports}}']);
  const row=stdout.split('\n').find(row=>row.includes('127.0.0.1:'+port+'->8080/tcp'));
  const id=row?.split(' ')[0];
  if(!id || !/^[a-f0-9]{64}$/.test(id))throw Error('Live container identity unavailable');
  const running=(await run('docker',['inspect','--format','{{.Image}} {{.State.Health.Status}}',id])).stdout.trim();
  if(running!==job.image+' healthy')throw Error('Live container changed');
  await runBrowser({html,source:'',sha:job.revision,image:project.calculatorBrowserImage,name:'jam-live-'+job.revision.slice(0,16),checks:['staticSvg'],site:'calculator',liveContainer:id,livePort:port});
  const directory=evidenceDir(job.revision,'deployed-'+port);
  const report=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
  const screenshots=await Promise.all(report.shots.map(async width=>({width,
    sha256:createHash('sha256').update(await readFile(join(directory,width+'.png'))).digest('hex')})));
  return {url,htmlDigest:expected.htmlDigest,screenshots,report:report.log};
}
