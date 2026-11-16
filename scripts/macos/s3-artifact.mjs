// Builds carry no publication credentials. The host identifies each release by the exact Git tree and its verified object hashes.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,writeFile,lstat,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const run=promisify(execFile);
export const hash=data=>createHash('sha256').update(data).digest('hex');
const fixedBuilds={
  'npm-dist':`cp -R /src/. /tmp/site; cd /tmp/site; cmp package-lock.json /opt/build/package-lock.json; rm -rf node_modules dist; ln -s /opt/build/node_modules node_modules; npm run build --offline; cp -R dist/. /out/`,
  'test-calculator':fixture('triangular'),
  'sandbox-sum':fixture('sum')
};
function fixture(module){
  return `mkdir -p "/out/assets/releases/$REV"; /opt/jam-bot/node_modules/.bin/tsc /src/src/${module}.ts --strict --target ES2022 --module ES2022 --outDir "/out/assets/releases/$REV"; sed "s#'./${module}.js'#'./assets/releases/$REV/${module}.js'#g" /src/web/index.html >/out/index.html; grep -F "assets/releases/$REV/${module}.js" /out/index.html >/dev/null`;
}
export async function collectAssets(dir){
  const objects={};let total=0;
  async function visit(prefix){
    for(const item of await readdir(join(dir,prefix),{withFileTypes:true})){
      const key=prefix+item.name,path=join(dir,key);
      if(!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(item.name)||key.length>512)throw Error('Invalid static artifact path');
      if(item.isDirectory()){await visit(key+'/');continue;}
      const st=await lstat(path);
      if(!st.isFile()||st.nlink!==1||st.size>16*1024*1024||(total+=st.size)>128*1024*1024||Object.keys(objects).length>=2000)throw Error('Invalid static artifact file or size');
      if(key==='build-manifest.json')continue;
      if(key!=='index.html' && !/^assets\/releases\/[\w-]+\//.test(key))throw Error('Only immutable assets and the root entry point are accepted');
      objects[key]=hash(await readFile(path));
    }
  }
  await visit('');
  if(!objects['index.html']||Object.keys(objects).length<2)throw Error('Static build produced no usable entry point or assets');
  const existing=await readFile(join(dir,'build-manifest.json'),'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;});
  if(existing){
    const manifest=JSON.parse(existing);
    if(Object.keys(manifest).length!==Object.keys(objects).length||Object.entries(objects).some(([k,v])=>manifest[k]!==v))throw Error('Artifact manifest disagrees with build output');
  }
  return Object.fromEntries(Object.entries(objects).sort(([a],[b])=>a.localeCompare(b,'en')));
}
export async function prepareArtifact(root,repoId,recipe,sha,image){
  const cfg=recipe.staticSite;
  if(!/^[\w-]+\/[\w.-]+$/.test(cfg.repository)||!/^[\w/-]{1,64}$/.test(cfg.ref)||!Object.hasOwn(fixedBuilds,cfg.build)||!/^sha256:[0-9a-f]{64}$/.test(image)||!/^[0-9a-f]{40}$/.test(sha))throw Error('Invalid registered build recipe');
  const dir=join(root,'s3-artifacts',String(repoId),sha,image.slice(7));await mkdir(join(dir,'..'),{recursive:true,mode:0o700});
  try{
    const receipt=JSON.parse(await readFile(join(dir,'receipt.json'),'utf8'));
    if(receipt.sha!==sha||receipt.image!==image||receipt.repoId!==repoId||receipt.build!==cfg.build||receipt.repo!==cfg.repository)throw Error('Artifact registration changed');
    return {dir:join(dir,'dist'),objects:await collectAssets(join(dir,'dist')),receipt};
  }catch(e){if(e.code!=='ENOENT')throw e;}
  const temp=await mkdtemp(join(tmpdir(),'jam-static-src-')),stage=dir+'.'+randomUUID();
  const call=async(bin,args)=> (await run(bin,args,{cwd:temp,timeout:120000,maxBuffer:1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();
  const git=(...args)=>call('git',['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','credential.helper=!gh auth git-credential',...args]);
  try{
    if(Number(await call('gh',['api','repos/'+cfg.repository,'--jq','.id']))!==repoId)throw Error('Build repository identity changed');
    await git('init','-q');await git('fetch','--no-tags','https://github.com/'+cfg.repository+'.git','refs/heads/'+cfg.ref);
    await git('merge-base','--is-ancestor',sha,'FETCH_HEAD');await git('checkout','--detach',sha);
    await rm(join(temp,'.git'),{recursive:true,force:true});
    await mkdir(join(stage,'dist'),{recursive:true,mode:0o700});
    const output=join(stage,'dist');
    // Docker Desktop maps the operator UID on bind mounts. Use that numeric non-root identity on Linux as well.
    const uid=process.getuid(),gid=process.getgid();
    if(!uid)throw Error('Run the artifact builder as an unprivileged operator');
    await call('docker',['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','768m','--cpus','1',
      '--user',uid+':'+gid,'--workdir','/tmp','--tmpfs','/tmp:rw,nosuid,nodev,size=192m','--mount','type=bind,src='+temp+',dst=/src,readonly','--mount','type=bind,src='+output+',dst=/out',
      '-e','HOME=/tmp','-e','REV='+sha,'--entrypoint','sh',image,'-ec',fixedBuilds[cfg.build]]);
    const objects=await collectAssets(output);await writeFile(join(output,'build-manifest.json'),JSON.stringify(objects)+'\n',{mode:0o600});
    const receipt={repoId,repo:cfg.repository,sha,image,build:cfg.build,manifest:hash(JSON.stringify(objects))};
    await writeFile(join(stage,'receipt.json'),JSON.stringify(receipt),{mode:0o600});await rename(stage,dir);
    return {dir:join(dir,'dist'),objects,receipt};
  }finally{await rm(temp,{recursive:true,force:true});await rm(stage,{recursive:true,force:true});}
}
