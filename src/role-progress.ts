export type Owner = 'Architect'|'Worker'|'Integrator';
export interface Update {identity:string; summary:string}
export function progressOwner(identity:string):Owner {
  if(/^(?:integrat|diagnosis[:-]|deployment:|await-site:|site-failed:|publication-|card-result-verified|fix-spec:|review-(?:retry|blocked):integrator)/.test(identity))return 'Integrator';
  if(/^(?:scope-plan:|material-decision:|card-accepted|waiting-profile|design|architect|spec-ready:|specification:)/.test(identity))return 'Architect';
  return 'Worker';
}

export function statusBlock(lines:string[]){
  return '```text\n'+lines.map(line=>'  '+line).join('\n')+'\n```';
}

export function roleChecklist(owner:Owner,history:Update[]){
  const start=owner==='Worker'?history.map(row=>/^(rework:|worker-revision:|worker-correction:)/.test(row.identity)).lastIndexOf(true):-1;
  const current=history.slice(Math.max(start,0));
  const has=(prefix:string)=>current.some(row=>row.identity.startsWith(prefix));
  const tasks:[string,boolean,boolean?][]=[];
  if(owner==='Architect' && has('scope-plan:') && !has('architecture:')){
    tasks.push(['Prepare the scope plan',true],['Attach the scope plan',true]);
  }else if(owner==='Architect'){
    tasks.push(['Prepare the architecture draft',has('architecture:'),has('architect-')]);
  }else if(owner==='Worker'){
    tasks.push(['Implement the approved scope',has('implementation:') || has('worker-revision:'),has('developer-') || has('rework:') || has('worker-correction:')]);
  }else{
    tasks.push(['Assemble the candidate',has('integration:')]);
  }
  const phase={Architect:'architecture',Worker:'implementation',Integrator:'diagnosis'}[owner];
  const prefix=phase+'-adviser:';
  const advisers=new Map<string,string>();
  for(const row of current.filter(row=>row.identity.startsWith(prefix))){
    const [, ,name,status]=row.identity.split(':');
    if(name && status)advisers.set(name,status);
  }
  for(const [name,status] of advisers)tasks.push([name+' review',status==='ok',status==='running']);
  if(owner==='Architect' && (!has('scope-plan:') || has('architecture:')))tasks.push(['Publish the specification',has('spec-ready:'),has('architecture:') && advisers.size>0 && [...advisers.values()].every(status=>status==='ok')]);
  if(owner==='Worker')tasks.push(['Pass review and branch validation',has('validated:'),has('consultant:') || has('validation:')]);
  if(owner==='Integrator'){
    const lastCandidate=history.map(row=>row.identity.startsWith('integration:')).lastIndexOf(true);
    const round=history.slice(Math.max(lastCandidate,0));
    tasks.push(['Pass combined tests',round.some(row=>row.identity.startsWith('integration-tests:')),round.some(row=>row.identity.startsWith('integration:'))],
      ['Approve the tested revision',round.some(row=>row.identity.startsWith('integration-review:')&&row.summary.includes('returned PASS')),round.some(row=>row.identity.startsWith('integration-tests:')) && !round.some(row=>row.identity.startsWith('integration-review:'))],
      ['Publish the verified revision to dev',has('integrated:'),round.some(row=>row.identity.startsWith('integration-review:') && row.summary.includes('returned PASS'))]);
  }
  const paused=current.at(-1)?.identity.startsWith('blocked:');
  const lines=tasks.map(([label,done,active])=>(done?'✅':active && !paused?'🟨':'◻️')+' '+label);
  const last=current.at(-1);
  const final=(last?.identity==='card-result-verified'||last?.identity.startsWith('deployment:')&&last.summary.endsWith('Deployment complete.'))?current.filter(row=>row.identity.startsWith('integrated:')).at(-1):undefined;
  const status=final?final.summary+(last?.identity.startsWith('deployment:')?' Deployment verified.':''):last?.summary??'';
  return '**🍯 JAM '+owner+': '+({Architect:'architecture and reviews',Worker:'implementation and validation',Integrator:'integration and publication'}[owner])+'**\n\n'+statusBlock(lines)+'\n\n'+status;
}

export function briefDecision(markdown:string, fallback:string){
  const lines=markdown.split('\n').map(line=>line.trim());
  const marked=lines.find(line=>/^Decision:\s+/i.test(line))?.replace(/^Decision:\s+/i,'');
  const choice=marked??lines.find(line=>line.length>=25 && line.length<=260 && !/^(?:#|[|`<>]|Candidate |\s*$)/.test(line));
  return choice && choice.length<=300 ? choice.replace(/^[-*] /,'').replaceAll('@','＠'):fallback;
}
