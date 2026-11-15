// Operator-supplied profiles. No issue, patch, package script or webhook selects shell commands.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
const recipes=new Set(['node-strip','typescript-build']);
const safeRepo=/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function projectRecipes(config) {
  const projects=config.projects ?? Object.fromEntries(config.repositories.map(repo=>[repo,{image:config.image,recipe:'node-strip'}]));
  for (const [repo,project] of Object.entries(projects)) {
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

async function calculatorPreview({tree,sha,image,name}) {
  const options={cwd:tree,maxBuffer:1024*1024};
  const blob=async path=>{
    const {stdout:entry}=await run('git',['ls-tree',sha,'--',path],options);
    const match=/^100644 blob ([0-9a-f]{40,64})\t/.exec(entry);
    if(!match)throw Error('Missing regular calculator input '+path);
    return (await run('git',['cat-file','blob',match[1]],options)).stdout;
  };
  const [html,source]=await Promise.all([blob('web/index.html'),blob('src/triangular.ts')]);
  const container=name+'-browser';
  const args=['run','--rm','-i','--name',container,'--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--pids-limit','128','--memory','768m','--cpus','1','--user','1000:1000',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=128m','-e','HOME=/tmp','-e','XDG_CACHE_HOME=/tmp/cache',image];
  try {
    const {stdout}=await new Promise((resolve,reject)=>{
      const child=execFile('docker',args,{timeout:60000,maxBuffer:65536},(error,stdout,stderr)=>{
        if(error)reject(Error('Calculator Chromium preview failed at '+sha+'\n'+(stdout+stderr).slice(-3000)));
        else resolve({stdout});
      });
      child.stdin.on('error',()=>{}); // A container startup failure is reported by execFile.
      child.stdin.end(JSON.stringify({sha,html,source}));
    });
    return stdout;
  } finally {await run('docker',['rm','-f',container]).catch(()=>{});}
}

export async function testCandidate({project,tree,files,sha,name}) {
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
    const preview=project.calculatorBrowserImage ? await calculatorPreview({tree,sha,image:project.calculatorBrowserImage,name}) : '';
    return {tests,log:log+'\n'+(diagnostic.length>5000 ? diagnostic.slice(0,400)+'\n…\n'+diagnostic.slice(-4600) : diagnostic)+'\n'+preview};
  } catch (error) {
    throw Error('Validation failed for '+project.recipe+'\n'+[error.stdout,error.stderr,(!error.stdout && !error.stderr)?error.message:'',error.killed?'Timed out':''].filter(Boolean).join('\n').slice(-8000));
  } finally { await run('docker',['rm','-f',name]).catch(()=>{}); }
}
