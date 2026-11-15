import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {digestOf,specName} from './specification-upload.js';
import type {issueClient} from './github-app.js';

type Api=Awaited<ReturnType<typeof issueClient>>;
type Item={number:number;id:number;html_url:string;name:string;type:string;body:string;creator:{id:number};updated_by_actor?:{id:number}|null};
type Comment={id:number;issue_url:string;body:string;user:{id:number}};
async function find<T>(api:Api,path:string,predicate:(item:T)=>boolean) {
  let match:T|undefined;
  for(let page=1;;page++){
    const rows:T[]=await api(path+'?per_page=100&page='+page);
    if(!Array.isArray(rows))throw Error('Invalid GitHub collection');
    for(const row of rows.filter(predicate)){if(match)throw Error('Multiple publication records need reconciliation');match=row;}
    if(rows.length<100)return match;
  }
}

// The intent is durable before POST. After a lost response use a matching remote record.
// Never repeat an ambiguous create. Known GitHub validation/rate-limit rejections are retryable.
export async function publishIssueSpec(state:string,repository:string,repoId:number,issue:number,markdown:string,
  botId:number,api:Api,authorize:()=>Promise<void>,signal:AbortSignal,purpose?:'review'|'tests'|'consultation') {
  const digest=digestOf(markdown),name=purpose?purpose+'-'+issue+'-'+digest.slice(0,12)+'.md':specName(issue,digest),base='/issues/'+issue,card='https://github.com/'+repository+base;
  const repositoryPath='https://api.github.com/repos/'+repository+base;
  if((await api('')).id!==repoId)throw Error('Repository identity changed before specification publication');
  const db=new DatabaseSync(join(state,'specifications.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS publications(issue INTEGER,digest TEXT,stage TEXT,receipt INTEGER,
        PRIMARY KEY(issue,digest,stage))`);
    async function once<T>(stage:string,search:()=>Promise<T|undefined>,post:()=>Promise<T>,id:(v:T)=>number,load:(id:number)=>Promise<T>){
      const params=[issue,digest,purpose?purpose+'-'+stage:stage];
      const saved=db.prepare('SELECT receipt FROM publications WHERE issue=? AND digest=? AND stage=?').get(...params);
      if(saved?.receipt)return load(Number(saved.receipt));
      for(let attempt=0;;attempt++){
        signal.throwIfAborted();
        let value=await search();
        if(!value){
          await authorize();
          const claimed=db.prepare('INSERT OR IGNORE INTO publications(issue,digest,stage) VALUES(?,?,?)').run(...params).changes;
          if(!claimed){
            if(attempt>=5)throw Error('Unconfirmed '+stage+' creation; reconcile the original work card before issuing another POST');
            await new Promise<void>(resolve=>setTimeout(resolve,2000));
            continue;
          }
          try{value=await post();}
          catch(err){
            const status=(err as {status?:number})?.status;
            if(status && [400,401,403,404,410,422,429].includes(status)){
              db.prepare('DELETE FROM publications WHERE issue=? AND digest=? AND stage=? AND receipt IS NULL').run(...params);
              throw err;
            }
            continue;
          }
        }
        const number=id(value);
        if(!Number.isSafeInteger(number)||number<=0)throw Error('Invalid remote '+stage+' identity');
        db.prepare('INSERT INTO publications(issue,digest,stage,receipt) VALUES(?,?,?,?) ON CONFLICT(issue,digest,stage) DO UPDATE SET receipt=excluded.receipt').run(...params,number);
        return load(number);
      }
    }
    const artifacts=base+'/artifacts';
    const artifact=await once<Item>('artifact',()=>find<Item>(api,artifacts,a=>a.name===name && a.creator?.id===botId),
      ()=>api(artifacts,'POST',{name,type:'generic',body:markdown}),a=>a.number,async n=>{
        // Individual GET includes version history, whereas lists and create return plain artifacts.
        const record=await api(artifacts+'/'+n);
        return record.artifact??record;
      });
    if(artifact.name!==name || artifact.type!=='generic' || artifact.creator?.id!==botId ||
       (artifact.updated_by_actor && artifact.updated_by_actor.id!==botId) || artifact.html_url!==card+'/artifacts/'+artifact.number ||
       typeof artifact.body!=='string' || !Buffer.from(artifact.body).equals(Buffer.from(markdown)))
      throw Error('GitHub issue artifact failed its original byte, issue or publisher verification');
    const body='['+name+']('+artifact.html_url+')';
    const comment=await once<Comment>('comment',()=>find<Comment>(api,base+'/comments',c=>c.user?.id===botId && c.body===body),
      ()=>api(base+'/comments','POST',{body}),c=>c.id,n=>api('/issues/comments/'+n));
    if(comment.issue_url!==repositoryPath || comment.user?.id!==botId || comment.body!==body)
      throw Error('GitHub issue comment failed its issue or publisher verification');
    return {name,sha256:digest,artifact:artifact.number,url:artifact.html_url,commentId:comment.id};
  }finally{db.close();}
}
