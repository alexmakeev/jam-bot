import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import {issueClient,publisherIdentity} from './github-app.js';
import type {Topic} from './intake-journal.js';
import {exchange,type ReviewPhase} from './profile-checkout.js';
import {atomicJson,readJson} from './storage.js';
import type {TaskApproval} from './task-approval.js';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const adviceSchema=z.array(z.object({name:z.string().regex(/^[a-zA-Z0-9_. -]{1,80}$/),provider:z.string().regex(/^[a-zA-Z0-9_. -]{1,80}$/),
  status:z.enum(['ok','unavailable','error']),text:z.string().max(6000)})).max(12);
type Advice=z.infer<typeof adviceSchema>;
type Fields=Record<string,string>;
type Card={issue:number;approval:TaskApproval};
interface Evidence {phase:ReviewPhase;repository:string;cards:number[];inputDigest:string;advice:Advice}
export interface ExternalReview {advice:Advice;inputDigest:string}

function bounded(key:string,value:string,limit:number){
  const full=Buffer.from(value);
  if(full.length<=limit)return value;
  const portion=Math.floor(limit/2);
  return full.subarray(0,portion).toString('utf8')+'\n[… '+key+' omitted; '+full.length+' bytes, SHA-256 '+sha(value)+' …]\n'+full.subarray(-portion).toString('utf8');
}

// Preserve complete short fields. Mark long excerpts explicitly with an immutable digest.
export function reviewPacket(fields:Fields,limit=60000):string {
  if(!Object.keys(fields).length||limit<2048)throw Error('Invalid consultant evidence packet');
  let perField=limit;
  for(;;){
    const packet=JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,bounded(k,v,perField)])));
    if(Buffer.byteLength(packet)<=limit)return packet;
    if(perField<=64)throw Error('Too many consultant evidence fields');
    perField=Math.floor(perField*0.65);
  }
}

export function adviserNotes(run:ExternalReview) {
  const replies=run.advice.filter(r=>r.status==='ok');
  if(!replies.length)return '';
  return reviewPacket(Object.fromEntries(replies.map((v,i)=>[i+' '+v.name+' ('+v.provider+')',v.text])),10000);
}

export async function externalReview(state:string,topic:Topic,cards:Card[],phase:ReviewPhase,fields:Fields,signal:AbortSignal,
  call=exchange,report=reportAdvice):Promise<ExternalReview>{
  const packet=reviewPacket(fields);
  const ids=cards.map(c=>c.issue);
  const inputDigest=sha(JSON.stringify([topic.repoId,phase,cards,packet]));
  const path=join(state,'consultations',inputDigest+'.json');
  let record=await readJson<Evidence>(path).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
  if(!record){
    const result=await call(join(state,'project.git'),{action:'consult',repo:topic.repository,cards,phase,packet},signal);
    // Older brokers must be upgraded before enabling this work profile.
    const advice=adviceSchema.parse(result.advice);
    record={phase,repository:topic.repository,cards:ids,inputDigest,advice};
    await atomicJson(path,record);
  }
  if(record.repository!==topic.repository || record.inputDigest!==inputDigest || record.phase!==phase ||
     JSON.stringify(record.cards)!==JSON.stringify(ids))throw Error('Consultation evidence identity changed');
  const advice=adviceSchema.parse(record.advice);
  for(const issue of ids){
    await atomicJson(join(state,'assignments',String(issue),'consultations',phase+'.json'),record);
    if(advice.length)await report(topic,issue,record);
  }
  return {advice,inputDigest};
}
async function reportAdvice(topic:Topic,issue:number,record:Evidence){
  const [api,publisher]=await Promise.all([issueClient(topic.repository,topic.installation),publisherIdentity(topic.repository,topic.installation)]);
  const path='/issues/'+issue+'/comments';
  const marker='<!-- jam-bot:consultation:'+record.phase+' -->';
  const described=record.advice.map(v=>v.name+' ('+v.provider+'): '+(v.status==='ok'?'review received':v.status));
  const body='External '+record.phase+' review — '+described.join(', ')+'. Evidence `'+record.inputDigest.slice(0,12)+'`.\n\n'+marker;
  for(let page=1;;page++){
    const rows=await api(path+'?per_page=100&page='+page) as {id:number;user:{id:number};body:string}[];
    const found=rows.find(item=>item.user.id===publisher && item.body.endsWith(marker));
    if(found){
      if(found.body!==body)await api('/issues/comments/'+found.id,'PATCH',{body});
      return;
    }
    if(rows.length<100)break;
  }
  await api(path,'POST',{body});
}
