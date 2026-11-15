// Operator-supplied profiles. No issue, patch, package script or webhook selects shell commands.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';

const run=promisify(execFile);
const recipes=new Set(['node-strip','typescript-build']);
const safeRepo=/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function projectRecipes(config) {
  const projects=config.projects ?? Object.fromEntries(config.repositories.map(repo=>[repo,{image:config.image,recipe:'node-strip'}]));
  for (const [repo,project] of Object.entries(projects)) {
    if(project?.clearTotalsCard!==undefined && (!project.sumBrowserImage || !Number.isSafeInteger(project.clearTotalsCard) || project.clearTotalsCard<1))throw Error('Invalid clear totals work card');
    if(project?.sumBrowserImage && (project.recipe!=='node-strip'||!/^sha256:[a-f0-9]{64}$/.test(project.sumBrowserImage)||!Number.isSafeInteger(project.runningTotalsCard)||project.runningTotalsCard<1))throw Error('Invalid sum page recipe');
    if (project?.calculatorSpecCards && (!project.calculatorBrowserImage || Object.entries(project.calculatorSpecCards).some(([check,issue])=>!['dragons','reset','staticSvg'].includes(check) || !Number.isSafeInteger(issue) || issue<1))) throw Error('Invalid calculator acceptance mapping');
    if (project?.calculatorBrowserImage && (project.recipe!=='typescript-build' || !/^sha256:[a-f0-9]{64}$/.test(project.calculatorBrowserImage))) throw Error('Invalid calculator browser image');
    if (!safeRepo.test(repo) || !project || !recipes.has(project.recipe) || typeof project.image!=='string' || !project.image || project.image.startsWith('-')) {
      throw Error('Invalid trusted project recipe');
    }
  }
  return projects;
}

const buildAndTest = `
set -eu
cp -R /code/. /workspace/
cd /workspace
node --version
/opt/jam-bot/node_modules/.bin/tsc --version
rm -rf -- dist
/opt/jam-bot/node_modules/.bin/tsc -p tsconfig.json
exec node --experimental-strip-types --test --test-concurrency=1 "$@"
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
  const baseline=checks.includes('staticSvg')?await blob('web/index.html',base):undefined;
  return runBrowser({html,source,server,baseline,sha,image,name,checks,site});
}

const evidenceDir=(sha,phase)=>join(homedir(),'.jam-bot','management','calculator-dev-evidence',sha,phase);

async function runBrowser({html,source,server,baseline,sha,image,name,checks,site,liveContainer,livePort}){
  if(!/^[0-9a-f]{40}$/.test(sha))throw Error('Invalid browser candidate revision');
  const deployed=Boolean(liveContainer);
  const proofs=evidenceDir(sha,deployed?'deployed-'+livePort:'candidate');
  const container=name+'-browser';
  const args=['run','--rm','-i','--name',container,'--network',liveContainer?'container:'+liveContainer:'none','--read-only','--cap-drop','ALL',
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

export async function testCandidate({project,tree,files,sha,base,name,approvedIssues=[]}) {
  const build=project.recipe==='typescript-build';
  if (!recipes.has(project.recipe)) throw Error('Unknown validation recipe');
  if (build && !files.includes('tsconfig.json')) throw Error('Missing tsconfig.json for typescript-build recipe');
  const matcher=build ? /^test\/.*\.test\.[cm]?[jt]s$/ : /^tests\/.*\.test\.[cm]?[jt]s$/;
  const tests=files.filter(file=>matcher.test(file));
  if (!tests.length) throw Error('No tracked tests found for '+project.recipe);
  const command=build ? ['sh','-c',buildAndTest,'jam-build',...tests] :
    ['sh','-c','set -eu; node --version; exec node --experimental-strip-types --test --test-concurrency=1 "$@"','jam-test',...tests];
  const [entry,...argv]=command;
  const args=['run','--rm','--name',name,'--network','none','--read-only','--cap-drop','ALL','--user','1000:1000',
    '--security-opt','no-new-privileges','--pids-limit','128','--memory','512m','--cpus','1','--tmpfs','/tmp:rw,noexec,nosuid,size=32m',
    '--mount','type=bind,src='+tree+',dst=/code,readonly','-w','/code'];
  if (build) args.push('--tmpfs','/workspace:rw,nosuid,nodev,size=96m,uid=1000,gid=1000,mode=700');
  try {
    const {stdout,stderr}=await run('docker',[...args,'--entrypoint',entry,project.image,...argv],{timeout:90000,maxBuffer:1024*1024});
    const log='Recipe: '+project.recipe+'\nImage: '+project.image+'\nBuild: '+(build?'tsc -p tsconfig.json':'native Node type stripping')+
      '\nCommand: node --experimental-strip-types --test --test-concurrency=1 '+tests.join(' ')+'\nExit code: 0\nRevision: '+sha;
    const diagnostic=stdout+(stderr?'\n'+stderr:'');
    const checks=Object.entries(project.calculatorSpecCards??{}).filter(([,issue])=>approvedIssues.includes(issue)).map(([check])=>check);
    if(project.sumBrowserImage && approvedIssues.includes(project.runningTotalsCard))checks.push('runningTotals');
    if(project.sumBrowserImage && approvedIssues.includes(project.clearTotalsCard))checks.push('clearTotals');
    const browserImage=project.sumBrowserImage??project.calculatorBrowserImage;
    const preview=browserImage ? await calculatorPreview({tree,sha,base,image:browserImage,name,checks,site:project.sumBrowserImage?'sum':'calculator'}) : '';
    return {tests,log:log+'\n'+(diagnostic.length>5000 ? diagnostic.slice(0,400)+'\n…\n'+diagnostic.slice(-4600) : diagnostic)+'\n'+preview};
  } catch (error) {
    throw Error('Validation failed for '+project.recipe+'\n'+[error.stdout,error.stderr,(!error.stdout && !error.stderr)?error.message:'',error.killed?'Timed out':''].filter(Boolean).join('\n').slice(-8000));
  } finally { await run('docker',['rm','-f',name]).catch(()=>{}); }
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
