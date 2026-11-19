// Environment-scoped atomic files. This module never returns an unmasked value.
import {constants} from 'node:fs';
import {mkdir,lstat,open,readdir,realpath,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {signEnvironment,selectEnvironmentRecipe} from './environment-wire.js';

const aliasPattern=/^[a-z][a-z0-9-]{0,39}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern=/^[a-f0-9]{64}$/;
class SecretError extends Error {}
const fail=message=>{throw new SecretError(message);};

export function maskSecret(value){
  const chars=Array.from(value);
  return chars.length<=4?'****':chars.slice(0,2).join('')+'****'+chars.slice(-2).join('');
}

async function regularValue(path,privateOnly=false){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const info=await file.stat();
    if(!info.isFile()||info.nlink!==1||info.size>65536||(privateOnly&&(info.mode&0o077)))fail('Invalid secret file');
    return await file.readFile('utf8');
  }finally{await file.close();}
}
async function privateDirectory(root,parts,create){
  let current=await realpath(root);
  for(const part of parts){
    current=join(current,part);
    if(create)await mkdir(current,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const info=await lstat(current);
    if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077))fail('Invalid credential directory');
  }
  return current;
}
async function credentialDirectory(root,repoId,environment,create=false){
  return privateDirectory(root,['projects',String(repoId),'.creds',environment],create);
}
async function syncDirectory(path){const file=await open(path,'r');try{await file.sync();}finally{await file.close();}}
async function replaceValue(folder,alias,value){
  const path=join(folder,alias),temporary=join(folder,'.write-'+randomUUID());
  const existing=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(existing&&(!existing.isFile()||existing.nlink!==1))fail('Invalid secret destination');
  const file=await open(temporary,'wx',0o600);
  try{
    try{await file.writeFile(value,'utf8');await file.sync();}finally{await file.close();}
    await rename(temporary,path);await syncDirectory(folder);
  }finally{await rm(temporary,{force:true});}
}

export async function managedSecretBindings(root,repoId,environment,refs,operatorSecrets={}){
  const resolved={...operatorSecrets};
  if(!Number.isSafeInteger(repoId)||repoId<1||!aliasPattern.test(environment))fail('Invalid secret target');
  let folder;
  try{folder=await credentialDirectory(root,repoId,environment);}catch(error){if(error.code==='ENOENT')return resolved;throw error;}
  for(const alias of refs){
    if(!aliasPattern.test(alias))fail('Invalid secret alias');
    if(Object.hasOwn(resolved,alias))continue;
    const path=join(folder,alias);
    const info=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(info){if(!info.isFile()||info.nlink!==1||(info.mode&0o077))fail('Invalid managed secret file');resolved[alias]=path;}
  }
  return resolved;
}

export async function hostSecretOperation(input,{root,exchange,token,serverId,recipe,db}){
  try{return await secretOperation(input,{root,exchange,token,serverId,recipe,db});}
  catch(error){
    if(input?.action==='secret-set'&&uuidPattern.test(input.blobId)){
      try{const blobs=await privateDirectory(exchange,['secret-blobs'],false);await rm(join(blobs,input.blobId),{force:true});}catch{}
    }
    if(error instanceof SecretError)throw error;
    throw new Error('Secret operation could not be confirmed');
  }
}

async function secretOperation(x,{root,exchange,token,serverId,recipe,db}){
  const keys=['id','at','serverId','repoId','environment','action','alias','requestId','blobId','blobDigest'];
  if(!x||typeof x!=='object'||Object.keys(x).some(key=>!keys.includes(key))||x.serverId!==serverId||
    !Number.isSafeInteger(x.repoId)||x.repoId<1||!aliasPattern.test(x.environment)||!recipe||recipe.repoId!==x.repoId||
    !['secret-set','secret-get'].includes(x.action)||(x.alias!==undefined&&!aliasPattern.test(x.alias)))fail('Secret target is outside host scope');
  if(selectEnvironmentRecipe([recipe],x.repoId,x.environment)!==recipe)fail('Secret target is outside host scope');
  if(x.action==='secret-get'){
    if(x.requestId!==undefined||x.blobId!==undefined||x.blobDigest!==undefined)fail('Invalid secret query');
    let folder;
    try{folder=await credentialDirectory(root,x.repoId,x.environment);}catch(error){if(error.code!=='ENOENT')throw error;}
    const aliases=x.alias?[x.alias]:[...new Set([
      ...Object.keys(recipe.secrets??{}).filter(name=>aliasPattern.test(name)),
      ...(folder?await readdir(folder):[]).filter(name=>aliasPattern.test(name))
    ])].sort();
    const secrets=[];
    for(const alias of aliases){
      const path=Object.hasOwn(recipe.secrets??{},alias)?recipe.secrets[alias]:folder?join(folder,alias):undefined;
      let value;
      try{if(path)value=await regularValue(path,!Object.hasOwn(recipe.secrets??{},alias));}
      catch(error){if(error.code!=='ENOENT')throw error;}
      secrets.push({alias,present:value!==undefined,masked:value===undefined?null:maskSecret(value)});
    }
    return {secrets};
  }
  if(!x.alias||!uuidPattern.test(x.requestId)||!uuidPattern.test(x.blobId)||!digestPattern.test(x.blobDigest))fail('Invalid secret write');
  if(Object.hasOwn(recipe.secrets??{},x.alias))fail('This secret alias is operator-managed');
  db.exec('CREATE TABLE IF NOT EXISTS secret_writes(requestId TEXT PRIMARY KEY,target TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,response TEXT)');
  const target=x.repoId+'/'+x.environment+'/'+x.alias;
  let previous=db.prepare('SELECT * FROM secret_writes WHERE requestId=?').get(x.requestId);
  if(previous&&(previous.target!==target||previous.digest!==x.blobDigest))fail('Secret request conflicts with its recorded operation');
  const blobs=await privateDirectory(exchange,['secret-blobs'],false);
  const blob=join(blobs,x.blobId);
  if(previous?.state==='done'){
    await rm(blob,{force:true});return JSON.parse(previous.response);
  }
  if(previous&&db.prepare("SELECT 1 FROM secret_writes WHERE target=? AND rowid>(SELECT rowid FROM secret_writes WHERE requestId=?)").get(target,x.requestId))fail('Secret write was superseded by a newer operation');
  const value=await regularValue(blob,true);
  if(!value.length||signEnvironment(token,'request','jam-secret-blob-v1\0'+value)!==x.blobDigest)fail('Secret blob integrity check failed');
  const folder=await credentialDirectory(root,x.repoId,x.environment,true);
  db.prepare("INSERT OR IGNORE INTO secret_writes(requestId,target,digest,state) VALUES(?,?,?,'prepared')").run(x.requestId,target,x.blobDigest);
  previous=db.prepare('SELECT * FROM secret_writes WHERE requestId=?').get(x.requestId);
  if(previous.target!==target||previous.digest!==x.blobDigest)fail('Secret request conflicts with its recorded operation');
  await replaceValue(folder,x.alias,value);
  const response={requestId:x.requestId,alias:x.alias,updated:true};
  db.prepare("UPDATE secret_writes SET state='done',response=? WHERE requestId=?").run(JSON.stringify(response),x.requestId);
  await rm(blob,{force:true});
  return response;
}
