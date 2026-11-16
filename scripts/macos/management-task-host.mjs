// Only the dedicated single-owner management credential can reach this host module.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';

const exec=promisify(execFile);
async function github(path,payload){
  const cmd=exec('gh',['api','--hostname','github.com',path,...(payload?['--method','POST','--input','-']:[])],{
    timeout:20000,maxBuffer:8*1024*1024,env:Object.fromEntries(['HOME','PATH','TMPDIR'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]))
  });
  if(payload){cmd.child.stdin.on('error',()=>{});cmd.child.stdin.end(JSON.stringify(payload));}
  try{return JSON.parse((await cmd).stdout);}catch{throw Error('GitHub user operation unavailable');}
}

export async function hostTask(input,serverId,db,config,api=github){
  if(input.serverId!==serverId || !Number.isSafeInteger(input.repoId) || !/^[\w-]+\/[\w.-]+$/.test(input.repository))throw Error('Invalid Task destination');
  let bound;
  try{bound=JSON.parse(await config());}catch{throw Error('Task author binding or write permission unavailable');}
  const repo='repos/'+input.repository;
  const [user,repository]=await Promise.all([api('user'),api(repo)]);
  if(!Array.isArray(bound.repoIds)||!bound.repoIds.includes(input.repoId)||bound.userId!==user.id||user.type!=='User'||
    bound.login!==user.login || repository.id!==input.repoId || repository.full_name!==input.repository ||
    !/^[a-zA-Z0-9-]+$/.test(user.login))throw Error('Task author binding or write permission unavailable');
  const access=await api(repo+'/collaborators/'+user.login+'/permission');
  if(access.user?.id!==user.id || !['admin','write'].includes(access.permission))throw Error('Task author binding or write permission unavailable');
  const author={login:user.login,id:user.id};
  if(input.action==='task_authority')return {repository:repository.full_name,author,permission:access.permission};
  const {requestId,title,body}=input;
  if(input.action!=='task_create'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)||typeof title!=='string'||!title.trim()||title.length>256||
    typeof body!=='string'||!body.trim()||body.length>5500||body.includes('jam-bot:owner-task:'))throw Error('Invalid Task scope');
  const marker='<!-- jam-bot:owner-task:'+requestId+' -->';
  const approvedBody=body+'\n\n'+marker;
  const scope=createHash('sha256').update(JSON.stringify([serverId,repository.id,user.id,title,body])).digest('hex');
  db.exec("CREATE TABLE IF NOT EXISTS management_tasks (requestId TEXT PRIMARY KEY, scope TEXT NOT NULL, started TEXT NOT NULL, issue INTEGER)");
  const start=new Date(Date.now()-60000).toISOString();
  const reserved=db.prepare('INSERT OR IGNORE INTO management_tasks VALUES(?,?,?,NULL)').run(requestId,scope,start).changes===1;
  const prior=db.prepare('SELECT * FROM management_tasks WHERE requestId=?').get(requestId);
  if(prior.scope!==scope)throw Error('Different Task scope already uses this request ID');
  function result(number){return {repository:repository.full_name,author,issue:number,url:'https://github.com/'+repository.full_name+'/issues/'+number,requestId};}
  if(prior.issue)return result(prior.issue);
  const matches=issue=>Number.isSafeInteger(issue.number)&&issue.number>0&&!issue.pull_request&&issue.user?.id===user.id&&issue.user?.type==='User'&&issue.title===title&&issue.body===approvedBody&&issue.type?.name==='Task';
  let found;
  if(reserved){
    const issue=await api(repo+'/issues',{title,body:approvedBody,type:'Task'});
    if(matches(issue))found=issue;
  }else{
    // An ambiguous POST is never repeated. Scan the bounded time range since the reserved attempt.
    for(let page=1;;page++){
      const issues=await api(repo+'/issues?creator='+user.login+'&state=all&since='+encodeURIComponent(prior.started)+'&per_page=100&page='+page);
      const pageMatches=issues.filter(matches);
      if(pageMatches.length>1 || (found && pageMatches.length))throw Error('Task creation outcome is pending reconciliation');
      found=pageMatches[0]??found;
      if(issues.length<100)break;
    }
  }
  if(!found)throw Error('Task creation outcome is pending reconciliation');
  db.prepare('UPDATE management_tasks SET issue=? WHERE requestId=? AND scope=?').run(found.number,requestId,scope);
  return result(found.number);
}
