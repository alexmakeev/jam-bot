export type Owner = 'Architect'|'Worker'|'Integrator';
export interface Update {identity:string; summary:string}
export function progressOwner(identity:string):Owner {
  if(/^(?:integrat|diagnosis[:-]|deployment:|await-site:|site-failed:|publication-|card-result-verified|fix-spec:|review-(?:retry|blocked):integrator)/.test(identity))return 'Integrator';
  if(/^(?:card-accepted|waiting-profile|design|architect|spec-ready:|specification:)/.test(identity))return 'Architect';
  return 'Worker';
}

export function roleChecklist(owner:Owner,history:Update[]){
  const start=owner==='Worker'?history.map(row=>row.identity.startsWith('rework:')).lastIndexOf(true):-1;
  const current=history.slice(Math.max(start,0));
  const has=(prefix:string)=>current.some(row=>row.identity.startsWith(prefix));
  const tasks:[string,boolean][]=[];
  if(owner==='Architect'){
    tasks.push(['Prepare the architecture draft',has('architecture:')]);
  }else if(owner==='Worker'){
    tasks.push(['Implement the approved scope',has('implementation:')]);
  }else{
    tasks.push(['Assemble the candidate',has('integration:')]);
  }
  const phase={Architect:'architecture',Worker:'implementation',Integrator:'diagnosis'}[owner];
  const prefix=phase+'-adviser:';
  const advisers=new Map<string,boolean>();
  for(const row of current.filter(row=>row.identity.startsWith(prefix))){
    const [, ,name,status]=row.identity.split(':');
    if(name)advisers.set(name,status==='ok');
  }
  for(const [name,ok] of advisers)tasks.push([name+' review',ok]);
  if(owner==='Architect')tasks.push(['Publish the specification',has('spec-ready:')]);
  if(owner==='Worker')tasks.push(['Pass review and branch validation',has('validated:')]);
  if(owner==='Integrator'){
    const lastCandidate=history.map(row=>row.identity.startsWith('integration:')).lastIndexOf(true);
    const round=history.slice(Math.max(lastCandidate,0));
    tasks.push(['Pass combined tests',round.some(row=>row.identity.startsWith('integration-tests:'))],
      ['Approve the tested revision',round.some(row=>row.identity.startsWith('integration-review:')&&row.summary.includes('returned PASS'))],
      ['Publish the verified revision to dev',has('integrated:')]);
  }
  const latest=history.slice(-4);
  const lines=tasks.map(([label,ok])=>'- ['+(ok?'x':' ')+'] '+label);
  for(const row of history.filter(row=>row.identity.startsWith('rework:')||row.identity.startsWith('fix-spec:')))lines.push('- [x] '+row.summary);
  const prior=history.slice(0,-4).map(row=>'- '+row.summary).join('\n');
  return '**'+owner+': '+({Architect:'architecture and reviews',Worker:'implementation and validation',Integrator:'integration and publication'}[owner])+'**\n\n'+lines.join('\n')+
    '\n\n**Latest updates**\n'+latest.map(row=>'- '+row.summary).join('\n')+
    (prior&&prior.length<42000?'\n\n<details><summary>Earlier updates</summary>\n\n'+prior+'\n\n</details>':'');
}
