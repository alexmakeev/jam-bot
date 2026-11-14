import { appReader, GitHubRequestError, issueClient } from './github-app.js';
import type { GitHubActor } from './github-authorization.js';
import type { ProfileCard } from './profile-card.js';
import type { Intake, Topic } from './intake-journal.js';

export interface TaskApproval {
  actor: GitHubActor;
  author: GitHubActor;
  kind?: ProfileCard['kind'];
  title: string;
  body: string;
  typeId: number;
}

export function taskClass(labels:unknown): ProfileCard['kind']|undefined {
  if(!Array.isArray(labels))throw Error('Task labels unavailable');
  const classes=labels.map(label=>typeof label==='string'?label:label?.name)
    .filter(name=>typeof name==='string' && name.startsWith('class:'));
  if(classes.length>1 || (classes.length && !['class:assignment','class:consultation','class:development'].includes(classes[0])))throw Error('Conflicting or unsupported Task class');
  return classes[0]?.slice(6) as ProfileCard['kind']|undefined;
}

export function approvalFromEvent(event: Intake): TaskApproval {
  if (event.action !== 'task' || !event.typeId || !event.actorId || !event.actorLogin || !event.authorId || !event.authorLogin ||
      !['opened','typed'].includes(event.approvalSource ?? '')) throw new Error('Missing signed native Task approval');
  return { actor:{id:event.actorId,login:event.actorLogin,type:'User'}, author:{id:event.authorId,login:event.authorLogin,type:'User'},
    kind:event.kind,title:event.title,body:event.body,typeId:event.typeId };
}

type Reader = (path:string)=>Promise<any>;
export async function hasTaskWriteAccess(topic:Topic,actor:GitHubActor,read?:Reader):Promise<boolean> {
  if(actor.type!=='User' || !Number.isSafeInteger(actor.id) || actor.id<=0 || !/^[A-Za-z0-9-]+$/.test(actor.login))return false;
  const api=read ?? await appReader(topic.repository,String(topic.installation));
  const path='repos/'+topic.repository;
  try{
    const [repo,permission]=await Promise.all([api(path),api(path+'/collaborators/'+encodeURIComponent(actor.login)+'/permission')]);
    if(repo.id!==topic.repoId)throw new Error('Configured repository identity changed');
    // GitHub's effective base permission covers custom roles and organization team grants.
    return permission?.user?.id===actor.id && permission.user.type==='User' && ['write','admin'].includes(permission.permission);
  }catch(error){if(error instanceof GitHubRequestError && error.status===404)return false; throw error;}
}

export async function validateTaskApproval(topic:Topic,number:number,approval:TaskApproval,lockIfNeeded=false,
  clients:{read:typeof appReader;write:typeof issueClient}={read:appReader,write:issueClient}) {
  const read=await clients.read(topic.repository,String(topic.installation));
  if(!await hasTaskWriteAccess(topic,approval.actor,read))throw new Error('Task approval actor lacks current write access');
  if(approval.author.id!==approval.actor.id && !await hasTaskWriteAccess(topic,approval.author,read))throw new Error('Task content author lacks current write access');
  const path='repos/'+topic.repository+'/issues/'+number;
  const check=(issue:any)=>{
    const kind=taskClass(issue.labels);
    if(kind!==approval.kind || issue.user?.id!==approval.author.id || issue.user?.type!=='User' || issue.number!==number || issue.pull_request || issue.state!=='open' || issue.type?.id!==approval.typeId ||
       issue.type?.name!=='Task' || issue.title!==approval.title || (issue.body ?? '')!==approval.body)
      throw new Error('Native Task type, open state or approved scope changed');
  };
  let issue=await read(path);check(issue);
  if(!issue.locked && lockIfNeeded){
    const write=await clients.write(topic.repository,topic.installation);
    await write('/issues/'+number+'/lock','PUT');
    issue=await read(path);check(issue);
  }
  if(issue.locked!==true)throw new Error('Task discussion lock could not be verified');
}
