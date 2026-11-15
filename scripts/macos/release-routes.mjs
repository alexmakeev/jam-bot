// Repository guidance selects concrete, operator-registered routes. It cannot supply executables or credentials.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const name=/^[a-z][a-z0-9-]{0,47}$/;
const sha=/^[a-f0-9]{40}$/;
const knownChecks=new Set(['unit','browser','live']);

export function parseReleaseRoutes(markdown){
  if(typeof markdown!=='string'||Buffer.byteLength(markdown)>65536)throw Error('Invalid release profile');
  const section=markdown.match(/^## Release routes\s*\n([\s\S]*?)(?=^##? |(?![\s\S]))/m)?.[1];
  if(!section)throw Error('Release routes section missing');
  const lines=section.trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(lines.length<3||lines.length>18)throw Error('Invalid release table size');
  const cells=line=>{
    if(!line.startsWith('|')||!line.endsWith('|'))throw Error('Invalid release route row');
    const values=line.slice(1,-1).split('|').map(x=>x.trim());
    if(values.length!==6)throw Error('Expected six release columns');return values;
  };
  if(cells(lines[0]).join(' ')!=='Source Channel Destination Trigger Checks Acceptance'||!cells(lines[1]).every(s=>/^:?-{3,}:?$/.test(s)))throw Error('Invalid release table header');
  const routes=[];
  for(const line of lines.slice(2)){
    const [source,channel,destination,trigger,tests,acceptance]=cells(line);
    const checkList=tests.split(',').map(s=>s.trim());
    const duration=/^(0|[1-9][0-9]{0,4})m$/.exec(acceptance);
    if(!/^(branch|channel):[a-zA-Z0-9][a-zA-Z0-9/_-]{0,63}$/.test(source)||source.endsWith('/')||source.includes('//')||
      !name.test(channel)||!name.test(destination)||!duration||
      !/^(checks|approval|daily@(?:[01][0-9]|2[0-3]):[0-5][0-9]Z)$/.test(trigger)||
      !checkList.every(c=>knownChecks.has(c))||new Set(checkList).size!==checkList.length||
      (channel==='stable'&&trigger!=='approval')||routes.some(r=>r.channel===channel)||source==='channel:'+channel)throw Error('Invalid, duplicate or unsafe release transition');
    if(source.startsWith('channel:')&&!routes.some(r=>r.channel===source.slice(8)))throw Error('Channel must have an earlier producer');
    routes.push({source,channel,destination,trigger,checks:checkList,acceptanceMinutes:Number(duration[1])});
  }
  return routes;
}

export function selectRoute(routes,policy,channel){
  const route=routes.find(r=>r.channel===channel),capability=policy.channels?.[channel];
  if(!route||!capability||!capability.sources?.includes(route.source)||!capability.triggers?.includes(route.trigger.split('@')[0])||
    !capability.destinations?.includes(route.destination)||!capability.requiredChecks?.every(c=>route.checks.includes(c))||
    route.acceptanceMinutes<(capability.minimumMinutes??0))throw Error('Release route exceeds installed recipe for '+channel);
  return route;
}

export function due(route,{now=Date.now(),sourceReadyAt,approved=false}){
  if(!Number.isFinite(sourceReadyAt)||now<sourceReadyAt)return false;
  if(route.trigger==='approval')return approved===true;
  if(route.trigger==='checks')return true;
  const [hour,minute]=route.trigger.slice(6,-1).split(':').map(Number);
  const slot=new Date(now);slot.setUTCHours(hour,minute,0,0);
  return slot.getTime()<=now && slot.getTime()>=sourceReadyAt;
}

export async function repositoryRoutes(repository,policy,command=exec){
  if(!/^[A-Za-z0-9-]+\/[\w.-]+$/.test(repository)||!policy||!Number.isSafeInteger(policy.repoId)||
    !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,63}$/.test(policy.profileRef))throw Error('Invalid installed project release policy');
  const api=async path=>JSON.parse((await command('gh',['api','repos/'+repository+path],{timeout:30000,maxBuffer:512*1024})).stdout);
  if((await api('')).id!==policy.repoId)throw Error('Repository identity changed');
  const revision=(await api('/commits/'+encodeURIComponent(policy.profileRef))).sha;
  if(!sha.test(revision))throw Error('Invalid release profile revision');
  const file=await api('/contents/.jam-bot/VALUES.md?ref='+revision);
  if(file.type!=='file'||file.encoding!=='base64'||file.size>65536)throw Error('Invalid repository values file');
  const routes=parseReleaseRoutes(Buffer.from(file.content,'base64').toString('utf8'));
  for(const route of routes)selectRoute(routes,policy,route.channel);
  return {revision,routes};
}
