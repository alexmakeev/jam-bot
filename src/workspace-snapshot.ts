import {DatabaseSync} from 'node:sqlite';
import {existsSync,createReadStream,createWriteStream} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rename,rm,lstat} from 'node:fs/promises';
import {join,relative,isAbsolute,dirname} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';
import {digestOf,specName} from './specification-upload.js';
import {atomicJson} from './storage.js';
import type {WorkspaceManifest} from './workspace-reader.js';
import {recordedArchitectSpecification} from './development-specification.js';

const run=promisify(execFile);
const hash=/^[a-f0-9]{40}$/;
export async function localSpecificationIndex(state:string,repository:string){
  const intake=join(state,'intake.sqlite'),publications=join(state,'specifications.sqlite');
  const entries:{issue:number;title:string;status:string;pendingVerification:number;specifications:{path:string;digest:string;url:string;kind:string;current:boolean;revision:string;publisher:number}[]}[]=[];
  const documents=new Map<string,Buffer>();
  if(!existsSync(intake))return {entries,documents};
  const db=new DatabaseSync(intake,{readOnly:true});
  const specs=existsSync(publications)?new DatabaseSync(publications,{readOnly:true}):undefined;
  try{
    db.exec('PRAGMA busy_timeout=5000');specs?.exec('PRAGMA busy_timeout=5000');
    const tasks=db.prepare("SELECT issue,title,state,workerState FROM intake WHERE action='task' AND lockVerified=1 AND actorId>0 AND authorId>0 AND typeId>0 AND approvalSource IN ('opened','typed') ORDER BY issue").all();
    for(const task of tasks){
      if(['abandon','abandoned'].includes(String(task.workerState))||task.state==='abandoned')continue;
      const issue=Number(task.issue);
      const integrated=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integration_batches'").get()&&db.prepare("SELECT 1 FROM integration_members m JOIN integration_batches b ON b.id=m.batch WHERE m.issue=? AND b.state='integrated' LIMIT 1").get(issue);
      if(integrated)continue;
      const folder=join(state,'assignments',String(issue));
      if(existsSync(join(folder,'closed.json'))){
        const closed=JSON.parse(await readFile(join(folder,'closed.json'),'utf8'));
        if(closed.issue!==issue||!hash.test(closed.head)||!hash.test(closed.dev))throw Error('Invalid local issue closure identity');
        continue;
      }
      const original=existsSync(join(folder,'architect.json'))?await recordedArchitectSpecification(folder).then(receipt=>receipt.output)
        .catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;}):undefined;
      const correction=existsSync(join(folder,'correction.json'))?JSON.parse(await readFile(join(folder,'correction.json'),'utf8')).feedback:undefined;
      const entry={issue,title:String(task.title),status:task.workerState==='complete'?'awaiting integration':String(task.workerState??task.state),pendingVerification:0,specifications:[] as {path:string;digest:string;url:string;kind:string;current:boolean;revision:string;publisher:number}[]};
      const rows=specs?.prepare("SELECT digest,receipt FROM publications WHERE issue=? AND stage='artifact' AND receipt IS NOT NULL ORDER BY digest").all(issue)??[];
      for(const row of rows){
        const digest=String(row.digest);if(!/^[a-f0-9]{64}$/.test(digest)||!Number.isSafeInteger(row.receipt)||Number(row.receipt)<1)throw Error('Invalid specification publication identity');
        const name=specName(issue,digest),folder=join(state,'assignments',String(issue),'attachments');
        const verification=join(folder,name+'.verified.json');
        if(!existsSync(verification)){entry.pendingVerification++;continue;}
        const source=join(folder,name),info=await lstat(source);
        if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw Error('Invalid local specification file');
        const bytes=await readFile(source);if(digestOf(bytes)!==digest)throw Error('Local specification differs from published digest');
        const receipt=JSON.parse(await readFile(verification,'utf8'));
        const url='https://github.com/'+repository+'/issues/'+issue+'/artifacts/'+row.receipt;
        if(receipt.sha256!==digest||receipt.url!==url||receipt.name!==name||receipt.artifact!==Number(row.receipt)||receipt.repository!==repository||!Number.isSafeInteger(receipt.repoId)||!Number.isSafeInteger(receipt.publisher)||receipt.publisher<1||!hash.test(receipt.revision))throw Error('Local specification receipt mismatch');
        const kind=bytes.toString('utf8').startsWith('# Correction for issue ')?'correction':'original';
        documents.set(name,bytes);entry.specifications.push({path:name,digest,url,kind,current:typeof (kind==='original'?original:correction)==='string'&&digestOf(kind==='original'?original:correction)===digest,revision:receipt.revision,publisher:receipt.publisher});
      }
      entries.push(entry);
    }
    return {entries,documents};
  }finally{db.close();specs?.close();}
}

export async function createWorkspaceSnapshot(state:string,store:string,revision:string,repository:string){
  if(!hash.test(revision)||!/^[-\w.]+\/[-\w.]+$/.test(repository))throw Error('Invalid workspace identity');
  const execute=(...args:string[])=>run('git',['-c','core.hooksPath=/dev/null',...args],{cwd:store,timeout:60000,maxBuffer:32*1024*1024});
  const resolved=(await execute('rev-parse','--verify',revision+'^{commit}')).stdout.trim();
  if(resolved!==revision)throw Error('Workspace revision changed');
  const {entries,documents}=await localSpecificationIndex(state,repository);
  const index=JSON.stringify({repository,entries},null,2)+'\n',specifications=digestOf(index);
  const root=join(state,'workspace-snapshots');await mkdir(root,{recursive:true,mode:0o700});
  const destination=join(root,revision+'-'+specifications),manifestPath=join(destination,'manifest.json');
  if(existsSync(manifestPath))return {manifestPath,identity:{revision,specifications}};
  const listing=(await execute('ls-tree','-rlz',revision)).stdout.split('\0').filter(Boolean);
  const objects:{object:string;size:number;path:string}[]=[];
  let total=0;
  for(const row of listing){
    const match=/^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t([\s\S]+)$/.exec(row);
    if(!match)throw Error('Workspace snapshot requires regular Git files; symlinks and submodules are unsupported');
    const path=match[4]!;
    if(isAbsolute(path)||path.includes('\\')||relative('.',path).startsWith('..')||path.split('/').some(p=>p==='.'||p==='..'||!p))throw Error('Unsafe repository path');
    objects.push({object:match[2]!,size:Number(match[3]),path});
    total+=Number(match[3]);if(total>2*1024**3)throw Error('Workspace snapshot exceeds the two-gigabyte budget');
  }
  const staging=await mkdtemp(join(root,'.preparing-'));
  try{
    const code=join(staging,'repository'),specs=join(staging,'specifications');await mkdir(code);await mkdir(specs);
    const archive=join(staging,'snapshot.tar');await execute('archive','--format=tar','--output='+archive,revision);
    await run('tar',['-xf',archive,'-C',code],{timeout:60000});await rm(archive);
    for(const item of objects){
      const target=join(code,item.path);let actual='';
      if(existsSync(target)){
        const digest=createHash('sha1').update('blob '+item.size+'\0');
        for await(const chunk of createReadStream(target))digest.update(chunk);
        actual=digest.digest('hex');
      }
      if(actual===item.object)continue;
      await mkdir(dirname(target),{recursive:true});
      const child=spawn('git',['-c','core.hooksPath=/dev/null','cat-file','blob',item.object],{cwd:store,stdio:['ignore','pipe','ignore']});
      const closed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Cannot materialize exact workspace blob')));});
      await Promise.all([pipeline(child.stdout,createWriteStream(target,{mode:0o400})),closed]);
    }
    await writeFile(join(specs,'index.json'),index,{mode:0o400});
    for(const [name,bytes] of documents)await writeFile(join(specs,name),bytes,{mode:0o400});
    const manifest:WorkspaceManifest={version:1,identity:{revision,specifications},roots:{repository:join(destination,'repository'),specifications:join(destination,'specifications')},audit:join(destination,'reads.jsonl')};
    await atomicJson(join(staging,'manifest.json'),manifest);
    try{await rename(staging,destination);}catch(error){if(!existsSync(manifestPath))throw error;}
    return {manifestPath,identity:manifest.identity};
  }finally{await rm(staging,{recursive:true,force:true});}
}
