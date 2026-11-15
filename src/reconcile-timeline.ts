import {join} from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {issueClient} from './github-app.js';
import {readJson} from './storage.js';
import {recordProgress,publishProgress,fingerprint,hasProgressIdentity} from './work-progress.js';
import type {TopicRuntime} from './topics.js';

export async function backfillTimeline(runtime:Pick<TopicRuntime,'state'|'topic'>,issue:number){
  const {state,topic}=runtime;
  const api=await issueClient(topic.repository,topic.installation);
  const card=await api('/issues/'+issue);
  if(card.number!==issue || card.type?.name!=='Task' || (await api('')).id!==topic.repoId)throw Error('Cannot establish the source work card');
  const dir=join(state,'assignments',String(issue));
  const files=await readdir(dir);
  const recorded=(id:string)=>hasProgressIdentity(state,issue,id);
  for(const [role,next] of [['designer','architecture'],['architect','specification handoff'],['assignment','development'],['developer','candidate validation']] as const){
    if(!files.includes(role+'.json'))continue;
    const saved=JSON.parse(await readFile(join(dir,role+'.json'),'utf8'));
    if(saved.backend!=='in-process'||!String(saved.nativeMember).startsWith(role+'-'+issue+'-')|| typeof saved.output!=='string')continue;
    const digest=fingerprint(saved.output);
    const current=await readJson<{identity:string}>(join(dir,'handoffs',digest+'.json')).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
    if(current && recorded(current.identity))continue;
    recordProgress(state,issue,'historical:'+saved.nativeMember+':'+digest,
      'Historical checkpoint reconstructed from a saved native receipt. '+role+' ('+saved.nativeMember+') delivered output `'+digest.slice(0,12)+'` for this card. The handoff was to '+next+'.');
  }
  const revisions=await readdir(join(dir,'reviews')).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return [];});
  for(const file of revisions.filter(name=>/^[0-9a-f]{40}\.json$/.test(name))){
    const review=JSON.parse(await readFile(join(dir,'reviews',file),'utf8'));
    if(file!==review.sha+'.json' || typeof review.feedback!=='string' || typeof review.passing!=='boolean')throw Error('Historical review identity mismatch');
    if(recorded('consultant-result:'+review.sha))continue;
    const decision=/^PASS\b/i.test(review.feedback.trim())?'PASS':'a correction request';
    recordProgress(state,issue,'historical:review:'+review.sha,
      'Historical code review of `'+review.sha+'` returned '+decision+'. Candidate tests '+(review.passing?'passed':'failed')+'. Next: '+(decision==='PASS'&&review.passing?'branch validation.':'developer correction.'),
      {purpose:'review',markdown:'# Code review\n\nCandidate `'+review.sha+'`\n\n'+review.feedback});
  }
  const phases=await readdir(join(dir,'consultations')).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return [];});
  for(const phase of phases.filter(name=>/^(architecture|implementation|diagnosis)\.json$/.test(name))){
    const evidence=JSON.parse(await readFile(join(dir,'consultations',phase),'utf8'));
    if(evidence.repository!==topic.repository || !evidence.cards?.includes(issue) || !/^[a-f0-9]{64}$/.test(evidence.inputDigest) || !Array.isArray(evidence.advice))throw Error('Historical consultation attribution mismatch');
    const replies=evidence.advice as {name:string;status:string;text:string}[];
    if(recorded('advice-report:'+evidence.inputDigest) || replies.every(r=>['','retry-'].some(prefix=>recorded(evidence.phase+':'+evidence.inputDigest+':'+prefix+r.name+r.status))))continue;
    recordProgress(state,issue,'historical:consultation:'+evidence.inputDigest,
      'Historical '+evidence.phase+' consultation record for input `'+evidence.inputDigest.slice(0,12)+'`. '+replies.map(a=>a.name+' reported '+a.status).join(', ')+'. The attached report preserves the recorded responses.',
      {purpose:'consultation',markdown:'# '+evidence.phase+' consultation\n\nInput `'+evidence.inputDigest+'`\n\n'+replies.map(a=>'## '+a.name+' ('+a.status+')\n\n'+a.text).join('\n\n')});
  }
  if(files.includes('reviewed-head-tests.json')){
    const result=JSON.parse(await readFile(join(dir,'reviewed-head-tests.json'),'utf8'));
    const ready=JSON.parse(await readFile(join(dir,'ready.json'),'utf8'));
    if(result.sha!==ready.sha || !/^[a-f0-9]{40}$/.test(result.sha))throw Error('Historical tested head disagrees with handoff');
    recordProgress(state,issue,recorded('validated:'+result.sha)?'validated:'+result.sha:'historical:tests:'+result.sha,'Historical branch validation passed for `'+result.sha+'`. The integrator was next.',
      {purpose:'tests',markdown:'# Branch validation\n\nCandidate `'+result.sha+'`\n\n'+result.log});
  }
  if(files.includes('result.json')){
    const result=JSON.parse(await readFile(join(dir,'result.json'),'utf8'));
    if(result.issue===issue && /^[a-f0-9]{40}$/.test(result.dev) && result.batch){
      const batch=join(state,'integration',result.batch);
      const candidate=JSON.parse(await readFile(join(batch,'candidate.json'),'utf8'));
      const review=JSON.parse(await readFile(join(batch,'integrator.json'),'utf8'));
      if(candidate.sha!==result.dev || review.backend!=='in-process' || !/^PASS\b/i.test(review.output.trim()))throw Error('Historical integration evidence does not match publication');
      const tested=await readJson<{sha:string;log:string}>(join(batch,'tests.json'));
      if(tested.sha===candidate.sha && recorded('integration-tests:'+candidate.sha))
        recordProgress(state,issue,'integration-tests:'+candidate.sha,'Integrator tested the combined candidate.',{purpose:'tests',markdown:'# Integration validation\n\nCandidate `'+candidate.sha+'`\n\n'+tested.log});
      recordProgress(state,issue,recorded('integration-review:'+candidate.sha)?'integration-review:'+candidate.sha:'historical:integrator:'+candidate.sha,'Historical integrator PASS on tested candidate `'+candidate.sha+'`. Dev publication is recorded. The attached report preserves the native review.',
        {purpose:'review',markdown:'# Integration review\n\nCandidate `'+candidate.sha+'`\n\n'+review.output});
    }
  }
  while(await publishProgress(state,topic)){}
}
