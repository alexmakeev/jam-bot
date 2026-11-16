// Authenticated management selects a revision; only the private catalog selects the bucket, resource and credentials.
import aws4 from 'aws4';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {lstat,readFile,mkdir,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {prepareArtifact,hash} from './s3-artifact.mjs';
const exec=promisify(execFile);
const mime={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',ico:'image/x-icon',woff2:'font/woff2',txt:'text/plain; charset=utf-8'};
function safeUrl(input){
  const url=new URL(input);
  if(url.search||url.hash||url.username||url.password||(url.protocol!=='https:'&&!(url.protocol==='http:'&&url.hostname==='127.0.0.1')))throw Error('Invalid host-registered static endpoint');
  return url;
}
async function privateJson(file){
  const st=await lstat(file);if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o077)||st.size>8192)throw Error('Invalid secret file');
  return JSON.parse(await readFile(file,'utf8'));
}
// Finish already-started requests before reporting a failure or switching the site's entry point.
export async function forObjects(keys,action){
  let next=0,failed;
  async function worker(){
    while(!failed && next<keys.length){
      const key=keys[next++];
      try{await action(key);}catch(error){failed=error;}
    }
  }
  await Promise.all(Array.from({length:Math.min(keys.length,4)},worker));
  if(failed)throw failed;
}
export function validateStaticSite(recipe,x){
  const c=recipe.staticSite;
  if(recipe.environment!==x.environment||recipe.repoId!==x.repoId||!['development','staging','stable'].includes(recipe.tier)||
    !/^[a-z0-9][a-z0-9.-]{1,60}[a-z0-9]$/.test(c.bucket)||!/^([a-zA-Z0-9_-]+\/)*$/.test(c.prefix??'')||
    !/^[a-z0-9-]+$/.test(c.region)||!c.credentialRef||!Object.hasOwn(recipe.secrets??{},c.credentialRef)||
    x.secretRefs?.length!==1||x.secretRefs[0]!==c.credentialRef||x.endpoint||Object.keys(x.appVariables??{}).length)throw Error('Static release target is outside registered recipe');
  if(!['https-purge','ssh-resource'].includes(c.cache?.mode))throw Error('Host cache purge recipe required');
  safeUrl(c.s3Endpoint);safeUrl(c.publicBase);
  if(c.cache.mode==='https-purge')safeUrl(c.cache.purgeUrl);
  else if(!/^[a-z0-9][a-z0-9-]{0,60}$/.test(c.cache.resource)||!/^[a-z0-9][a-z0-9@.-]{0,120}$/.test(c.cache.sshHost))throw Error('Invalid cache resource or SSH host');
  return c;
}
export async function releaseStaticSite(root,recipe,x){
  const c=validateStaticSite(recipe,x),namespace=join(root,'s3-state',String(x.repoId),x.environment);
  await mkdir(namespace,{recursive:true,mode:0o700});
  const path=join(namespace,'current.json');
  const saved=await readFile(path,'utf8').then(JSON.parse).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
  const credentials=await privateJson(recipe.secrets[c.credentialRef]);
  if(!credentials.accessKeyId||!credentials.secretAccessKey)throw Error('Static storage credentials missing');
  const origin=safeUrl(c.s3Endpoint),front=safeUrl(c.publicBase);
  if(!front.pathname.endsWith('/'))throw Error('Cache base must end with slash');
  async function request(method,key,body,headers={}){
    const path='/'+c.bucket+'/'+(c.prefix??'')+key;
    const signed=aws4.sign({host:origin.host,path,region:c.region,service:'s3',method,headers:{...headers},body},credentials);
    const res=await fetch(new URL(path,origin),{method,headers:signed.headers,body,redirect:'error',signal:AbortSignal.timeout(10000)});
    if(res.status===404 && method==='GET')return null;
    if(!res.ok)throw Error('Object store '+method+' failed with HTTP '+res.status);
    return {body:Buffer.from(await res.arrayBuffer()),headers:res.headers};
  }
  async function verifyCache(key,digest){
    const res=await fetch(new URL(key==='index.html'?'':key,front),{redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!res.ok||hash(Buffer.from(await res.arrayBuffer()))!==digest)throw Error('Public cache differs from the tested artifact');
  }
  async function purge(){
    if(c.cache.mode==='ssh-resource'){
      await exec('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5',c.cache.sshHost,'python3 /opt/vsemu-s3-cache/purge.py '+c.cache.resource],{timeout:20000});return;
    }
    const res=await fetch(c.cache.purgeUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:credentials.cacheToken?{Authorization:'Bearer '+credentials.cacheToken}:{}});
    if(!res.ok)throw Error('Resource cache purge failed with HTTP '+res.status);
  }
  const result=(healthy,receipt)=>({environment:x.environment,running:healthy,healthy,revision:healthy?receipt.revision:null,image:null,endpoint:null,
    ...(healthy&&x.includePublication?{publication:{url:c.publicBase,manifestSha256:receipt.objects['build-manifest.json'],objectCount:Object.keys(receipt.objects).length,verifiedAt:receipt.verifiedAt,cacheVerified:true}}:{})});
  if(x.action==='stop')throw Error('Static release recipe disallows deleting or disabling published objects');
  if(x.action==='status'){
    if(!saved)return result(false,null);
    try{
      const actual=await request('GET','index.html');
      if(!actual||hash(actual.body)!==saved.objects['index.html'])return result(false,null);
      await verifyCache('index.html',saved.objects['index.html']);return result(true,saved);
    }catch{return result(false,null);}
  }
  const build=await prepareArtifact(root,x.repoId,recipe,x.revision,recipe.releases[x.revision]);
  if(build.receipt.manifest!==hash(JSON.stringify(build.objects)))throw Error('Staged artifact digest changed');
  const objects={...build.objects,'build-manifest.json':hash(await readFile(join(build.dir,'build-manifest.json')))};
  if(saved?.revision===x.revision && saved.build.manifest===build.receipt.manifest && saved.publicBase===c.publicBase && saved.bucket===c.bucket && saved.prefix===(c.prefix??'')){
    let intact=true;
    await forObjects(Object.keys(objects),async key=>{
      const existing=await request('GET',key);
      if(!existing||hash(existing.body)!==objects[key]){intact=false;return;}
      try{await verifyCache(key,objects[key]);}catch{intact=false;}
    });
    if(intact)return result(true,saved);
  }
  async function upload(key){
    const body=await readFile(join(build.dir,key));
    if(hash(body)!==objects[key])throw Error('Release bytes changed after validation');
    const prior=await request('GET',key);
    if(prior&&hash(prior.body)===objects[key])return;
    if(prior&&key.startsWith('assets/releases/'))throw Error('Immutable asset key is occupied by different bytes');
    const headers={'Content-Type':mime[key.split('.').pop()]??'application/octet-stream','Cache-Control':'no-cache'};
    if(prior && prior.headers.get('etag'))headers['If-Match']=prior.headers.get('etag');
    if(!prior)headers['If-None-Match']='*';
    await request('PUT',key,body,headers);
    const stored=await request('GET',key);
    if(!stored || hash(stored.body)!==objects[key])throw Error('Object store did not retain verified bytes');
  }
  await forObjects(Object.keys(build.objects).filter(k=>k!=='index.html'),upload);
  await upload('build-manifest.json');
  await upload('index.html');
  await purge();
  await forObjects(Object.keys(objects),key=>verifyCache(key,objects[key]));
  const receipt={revision:x.revision,repoId:x.repoId,environment:x.environment,bucket:c.bucket,prefix:c.prefix??'',publicBase:c.publicBase,objects,verifiedAt:new Date().toISOString(),build:build.receipt};
  const tmp=path+'.'+randomUUID();await writeFile(tmp,JSON.stringify(receipt)+'\n',{mode:0o600});await rename(tmp,path);
  return result(true,receipt);
}
