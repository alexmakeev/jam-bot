import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {issueClient, publisherIdentity} from './github-app.js';
import {digestOf} from './specification-upload.js';
import type {Topic} from './intake-journal.js';

type Expected = {number:number; digest:string; name:string};
type Artifact = {number:number; name:string; type:string; html_url:string; body:string; creator:{id:number}; updated_by_actor?:{id:number}|null};

export async function verifyArtifactPages(repository:string,issue:number,bot:number,expected:Expected[],
  readPage:(page:number)=>Promise<Artifact[]>) {
  const pending=new Map(expected.map(item=>[item.number,item]));
  for(let page=1;pending.size;page++){
    const rows=await readPage(page);
    for(const item of rows){
      const saved=pending.get(item.number);
      if(!saved)continue;
      if(item.type!=='generic' || item.creator?.id!==bot || (item.updated_by_actor && item.updated_by_actor.id!==bot) ||
        item.html_url!=='https://github.com/'+repository+'/issues/'+issue+'/artifacts/'+item.number ||
        item.name!==saved.name || typeof item.body!=='string' || digestOf(item.body)!==saved.digest)
        throw Error('Published artifact differs from its verified receipt: '+saved.name);
      pending.delete(item.number);
    }
    if(rows.length<100)break;
  }
  if(pending.size)throw Error('Published artifact missing from original issue: '+[...pending.values()].map(item=>item.name).join(', '));
}

export async function reconcileIssueArtifacts(state:string,topic:Topic,issue:number) {
  const file=join(state,'specifications.sqlite');
  if(!existsSync(file))return [];
  const db=new DatabaseSync(file,{readOnly:true});
  let expected:Expected[];
  try{
    db.exec('PRAGMA busy_timeout=5000');
    const rows=db.prepare("SELECT receipt,stage,digest FROM publications WHERE issue=? AND receipt IS NOT NULL AND (stage='artifact' OR stage LIKE '%-artifact')").all(issue);
    expected=rows.map(row=>{
      const digest=String(row.digest);
      const purpose=row.stage==='artifact'?'spec':String(row.stage).slice(0,-'-artifact'.length);
      return {number:Number(row.receipt),digest,name:purpose+'-'+issue+'-'+digest.slice(0,12)+'.md'};
    });
  }finally{db.close();}
  if(!expected.length)return [];
  const [api,bot]=await Promise.all([issueClient(topic.repository,topic.installation),publisherIdentity(topic.repository,topic.installation)]);
  if((await api('')).id!==topic.repoId)throw Error('Artifact recovery repository mismatch');
  await verifyArtifactPages(topic.repository,issue,bot,expected,page=>api('/issues/'+issue+'/artifacts?per_page=100&page='+page));
  return expected.map(item=>({name:item.name,url:'https://github.com/'+topic.repository+'/issues/'+issue+'/artifacts/'+item.number,digest:item.digest}));
}
