import {readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {atomicJson,readJson} from './storage.js';
import {recordProgress} from './work-progress.js';
import type {Topic} from './intake-journal.js';

interface VerifiedSite {
  repoId:number; repository:string; environment:string; revision:string; image:string; port:number; verifiedAt:number; issues:number[]; acceptance?:'passed'|'failed';
  evidence?:{url:string;htmlDigest:string;screenshots:{width:number;sha256:string}[];report:string};
}

// The host writes after checking the actual running image, endpoint and revision.
// Require the original issue's local integration receipt before announcing its deployment.
export async function collectDeploymentProgress(state:string,topic:Topic,exchange=process.env.JAM_PROFILE_EXCHANGE??'/var/lib/jam-profile-exchange') {
  const dir=join(exchange,'deployments',String(topic.repoId));
  const entries=await readdir(dir).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return [];});
  for(const file of entries){
    if(!/^[a-f0-9]{40}\.json$/.test(file))continue;
    const path=join(dir,file),site=await readJson<VerifiedSite>(path);
    if(site.repository!==topic.repository || site.repoId!==topic.repoId || file!==site.revision+'.json' ||
      !/^sha256:[0-9a-f]{64}$/.test(site.image) || !/^[a-z0-9-]{1,50}$/.test(site.environment) ||
      !Number.isSafeInteger(site.port) || site.port<1 || site.port>65535 || !Number.isSafeInteger(site.verifiedAt) ||
      !Array.isArray(site.issues) || !site.issues.length || site.issues.length>15 ||
      !site.issues.every(id=>Number.isSafeInteger(id)&&id>0))continue;
    let complete=true;
    for(const issue of site.issues){
      const result=await readJson<{issue:number;dev:string}>(join(state,'assignments',String(issue),'result.json'))
        .catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
      if(!result || result.issue!==issue || result.dev!==site.revision){complete=false;continue;}
      if(site.acceptance==='failed'){
        recordProgress(state,issue,'deployment-failed:'+site.revision,'The development host found a deployed acceptance failure for tested commit `'+site.revision+'`. The integrator must review the host report before closure.');
        continue;
      }
      const proof=site.evidence;
      const report=site.acceptance==='passed' && proof && typeof proof.report==='string' && proof.report.length<16000 &&
        Array.isArray(proof.screenshots) && proof.screenshots.every(s=>Number.isSafeInteger(s.width) && /^[0-9a-f]{64}$/.test(s.sha256))
        ? {purpose:'tests' as const,markdown:'# Deployed browser acceptance\n\nRevision `'+site.revision+'`. Local site `http://127.0.0.1:'+site.port+'/`.\n\nHTML SHA-256 `'+proof.htmlDigest+'`.\n\n'+
          proof.screenshots.map(s=>'- '+s.width+' px screenshot SHA-256 `'+s.sha256+'`').join('\n')+'\n\n'+proof.report} : undefined;
      recordProgress(state,issue,'deployment:'+site.environment+':'+site.revision,
        'The development host verified tested commit `'+site.revision+'` running healthy in `'+site.environment+'` at '+
        '`http://127.0.0.1:'+site.port+'/` on '+new Date(site.verifiedAt).toISOString()+'. Image `'+site.image+'`. Deployment complete.',report);
    }
    if(complete){await atomicJson(join(state,'deployments',file),site);await rm(path,{force:true});}
  }
}

export async function deploymentVerified(state:string,repoId:number,sha:string,issue:number):Promise<boolean>{
  if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Invalid deployment revision');
  const site=await readJson<VerifiedSite>(join(state,'deployments',sha+'.json')).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
  if(!site || site.revision!==sha || site.repoId!==repoId || !site.issues.includes(issue))return false;
  if(site.acceptance==='failed')throw Error('Deployed acceptance failed for '+sha+'; inspect the host report');
  return site.acceptance==='passed';
}
