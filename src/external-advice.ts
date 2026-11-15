import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import {issueClient,publisherIdentity} from './github-app.js';
import type {Topic} from './intake-journal.js';
import {exchange,type ReviewPhase,type ConsultationProgress} from './profile-checkout.js';
import {atomicJson,readJson} from './storage.js';
import type {TaskApproval} from './task-approval.js';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const adviceSchema=z.array(z.object({name:z.string().regex(/^[a-zA-Z0-9_. -]{1,80}$/),provider:z.string().regex(/^[a-zA-Z0-9_. -]{1,80}$/),
  model:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._()/-]{0,99}$/).optional(),startedAt:z.iso.datetime().optional(),finishedAt:z.iso.datetime().optional(),status:z.enum(['ok','unavailable','error']),text:z.string().max(6000)})).max(12);
type Advice=z.infer<typeof adviceSchema>;
type Fields=Record<string,string>;
type Card={issue:number;approval:TaskApproval};
export type DecisionInput={kind:'in_flight';evidence:ConsultationProgress}|{kind:'confirmed_failure';evidence:Advice};
export type Decide=(input:DecisionInput)=>Promise<string>;
interface Evidence {phase:ReviewPhase;repository:string;cards:number[];inputDigest:string;advice:Advice;attempts?:Advice[]}
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
  return reviewPacket(Object.fromEntries(replies.map((v,i)=>[i+' '+v.name+' ('+[v.provider,v.model].filter(Boolean).join(', ')+')',v.text])),10000);
}

export async function externalReview(state:string,topic:Topic,cards:Card[],phase:ReviewPhase,fields:Fields,signal:AbortSignal,
  decide:Decide,call=exchange,report=reportAdvice):Promise<ExternalReview>{
  const packet=reviewPacket(fields);
  const ids=cards.map(c=>c.issue);
  const inputDigest=sha(JSON.stringify([topic.repoId,phase,cards,packet]));
  const path=join(state,'consultations',inputDigest+'.json');
  const choose=async(input:DecisionInput)=>{
    const output=await decide(input);
    const decision=/^\s*(WAIT|RETRY|CONTINUE|ESCALATE)\b/i.exec(output)?.[1]?.toUpperCase();
    if(!decision)throw Error('Stage owner did not provide a consultation recovery decision');
    await atomicJson(join(state,'consultations',inputDigest+'.'+input.kind+'.json'),{at:new Date().toISOString(),phase,input,decision,output});
    return decision;
  };
  const onSlow=async(evidence:ConsultationProgress)=>{
    // Keep the original request alive. A running provider cannot be retried as a failed call.
    const decision=await choose({kind:'in_flight',evidence});
    if(decision==='ESCALATE')throw Error('The stage owner escalated an active consultation to Leo; inspect the existing request before retrying');
    if(decision!=='WAIT')throw Error('An active consultant must finish or be reconciled before another call');
  };
  let record=await readJson<Evidence>(path).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
  if(!record){
    const result=await call(join(state,'project.git'),{action:'consult',repo:topic.repository,cards,phase,packet},signal,onSlow);
    // Older brokers must be upgraded before enabling this work profile.
    const advice=adviceSchema.parse(result.advice);
    record={phase,repository:topic.repository,cards:ids,inputDigest,advice};
    await atomicJson(path,record);
  }
  if(record.repository!==topic.repository || record.inputDigest!==inputDigest || record.phase!==phase ||
     JSON.stringify(record.cards)!==JSON.stringify(ids))throw Error('Consultation evidence identity changed');
  let advice=adviceSchema.parse(record.advice);
  const retry=advice.filter(a=>a.status==='error').map(a=>a.name);
  let decision:string|undefined;
  if(retry.length)decision=await choose({kind:'confirmed_failure',evidence:advice});
  if(retry.length && decision==='RETRY' && (record.attempts?.length??1)<2){
    const result=await call(join(state,'project.git'),{action:'consult',repo:topic.repository,cards,phase,packet,only:retry},signal,onSlow);
    const received=adviceSchema.parse(result.advice);
    if(received.length!==retry.length || !retry.every(name=>received.filter(a=>a.name===name).length===1))
      throw Error('Consultant retry returned different profiles');
    const previous=advice;
    advice=advice.map(original=>received.find(a=>a.name===original.name && a.provider===original.provider)??original);
    record={...record,advice,attempts:[previous,received]};
    await atomicJson(path,record);
  }
  for(const issue of ids){
    await atomicJson(join(state,'assignments',String(issue),'consultations',phase+'.json'),record);
    if(advice.length)await report(topic,issue,record);
  }
  if(decision!=='CONTINUE' && advice.some(a=>a.status==='error'))throw Error('Configured consultant failed after retry; inspect retained consultation evidence');
  return {advice,inputDigest};
}
async function reportAdvice(topic:Topic,issue:number,record:Evidence){
  const [api,publisher]=await Promise.all([issueClient(topic.repository,topic.installation),publisherIdentity(topic.repository,topic.installation)]);
  const path='/issues/'+issue+'/comments';
  const marker='<!-- jam-bot:consultation:'+record.phase+' -->';
  const described=record.advice.map(v=>v.name+' ('+[v.provider,v.model].filter(Boolean).join(', ')+'): '+(v.status==='ok'?'review received':v.status));
  const retry=record.attempts && record.attempts.length>1?' A failed call was retried.':'';
  const body='External '+record.phase+' review — '+described.join(', ')+'.'+retry+' Evidence `'+record.inputDigest.slice(0,12)+'`.\n\n'+marker;
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
