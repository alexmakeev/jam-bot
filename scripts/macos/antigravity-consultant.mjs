import {execFile} from 'node:child_process';
import {providerFailureReason} from './consultants.mjs';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {workspaceBrief} from './consultant-workspace.mjs';

const exec=promisify(execFile);
const denied=['read_file','write_file','read_url','execute_url','download_url','command','unsandboxed','mcp'].map(action=>action+'(*)');
const settings=JSON.stringify({agentMode:'plan',allowNonWorkspaceAccess:false,permissions:{deny:denied}});
const endpoint='http://jam-antigravity-provider-proxy:3130';
export function antigravityArgs(profile,name,question='Give concise independent technical advice.',workspace){
  if(!/^sha256:[a-f0-9]{64}$/.test(profile.image)||profile.volume!=='jam-antigravity-home')throw Error('Invalid isolated Antigravity profile');
  if(profile.model!==undefined&&!/^[a-zA-Z0-9][a-zA-Z0-9 ._()/-]{0,99}$/.test(profile.model))throw Error('Invalid Antigravity model');
  const minutes=profile.timeoutMinutes??30;
  if(!Number.isInteger(minutes)||minutes<1||minutes>30)throw Error('Invalid Antigravity timeout');
  return ['run','--rm','--interactive','--pull=never','--name',name,'--network','jam-antigravity-private','--read-only',
    '--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','150','--memory','1536m','--cpus','2','--user','1000:1000',
    '--mount','type=volume,src='+profile.volume+',dst=/home/jam','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=128m','--workdir','/work',
    ...(workspace?['--mount','type=bind,src='+workspace.root+',dst=/review,readonly','--mount','type=bind,src='+workspace.root+'/agents,dst=/work/.agents,readonly','--mount','type=bind,src='+workspace.root+'/empty-global-mcp.json,dst=/home/jam/.gemini/config/mcp_config.json,readonly','--mount','type=bind,src='+workspace.audit+',dst=/audit']:[]),
    '--env','JAM_REVIEW_QUESTION='+question+(workspace?' '+workspaceBrief:''),'--env','HOME=/home/jam','--env','HTTPS_PROXY='+endpoint,'--env','HTTP_PROXY='+endpoint,'--env','NO_PROXY=localhost,127.0.0.1',
    '--entrypoint','/bin/sh',profile.image,'-ec',
    'packet=$(cat); exec /usr/local/bin/agy "$@" -p "${JAM_REVIEW_QUESTION}\n$packet"',
    'consult','--mode','plan','--settings',workspace?JSON.stringify({agentMode:'plan',allowNonWorkspaceAccess:false,permissions:{deny:denied.filter(rule=>rule!=='mcp(*)'),allow:['mcp(jam_workspace/workspace_list)','mcp(jam_workspace/workspace_read)','mcp(jam_workspace/workspace_search)']}}):settings,'--disable-slash-commands','--print-timeout',String(minutes)+'m',
    ...(profile.model?['--model',profile.model]:[]),...(profile.effort?['--effort',profile.effort]:[]),'--output-format','text'];
}
export async function consultAntigravity({profile,packet,signal,question,onOutput,workspace}){
  if(typeof packet!=='string'||Buffer.byteLength(packet)>65536||!packet.trim())throw Error('Invalid Antigravity review packet');
  const name='jam-agy-review-'+randomUUID();
  const args=antigravityArgs(profile,name,question,workspace);
  signal?.throwIfAborted();
  try{
    const job=exec('docker',args,{signal,timeout:((profile.timeoutMinutes??30)*60+15)*1000,maxBuffer:512*1024});
    job.child.stdout.on('data',chunk=>onOutput?.(Buffer.byteLength(chunk)));
    job.child.stdin.on('error',()=>{});
    job.child.stdin.end(packet);
    const {stdout}=await job;
    const result=stdout.trim();
    if(!result)throw Error('Empty review');
    return result.slice(0,6000);
  }catch(error){
    const transient=!signal?.aborted && /timeout|timed out|deadline exceeded|connection reset|temporarily unavailable|service unavailable|429|503/i.test(String(error.stderr??''));
    throw Object.assign(Error(signal?.aborted?'Antigravity consultation cancelled':'Antigravity consultation unavailable'),{transient,reason:providerFailureReason(String(error.stderr??''))});
  }
  finally{await exec('docker',['rm','--force',name],{timeout:10000}).catch(()=>{});}
}
