import {z} from 'zod';
import {ownerHostRequest} from './environment-runner.js';
import {ManagementError,requireTopic,targetFields,type ManagementOperation} from './management-contract.js';
import {parseTaskCard} from './profile-card.js';
import type {TopicRuntime} from './topics.js';

const target=z.strictObject(targetFields);
const author=z.strictObject({login:z.string(),id:z.int().positive()});
const authority=z.strictObject({repository:z.string(),author,permission:z.enum(['write','admin'])});
const created=z.strictObject({repository:z.string(),author,issue:z.int().positive(),url:z.url(),requestId:z.uuid()});
const input=target.extend({requestId:z.uuid(),title:z.string().trim().min(1).max(256),body:z.string().trim().min(1).max(5500)});
export function taskOperations(routes:ReadonlyMap<string,TopicRuntime>,host:typeof ownerHostRequest=ownerHostRequest):ManagementOperation[]{
  async function call(action:string,args:Record<string,unknown> & {repoId:number}){
    const {topic}=requireTopic(routes,args.repoId);
    try{return await host<Record<string,unknown>>({...args,action,repository:topic.repository});}
    catch(error){
      const message=error instanceof Error ? error.message : '';
      if(message==='Different Task scope already uses this request ID')throw new ManagementError(409,'task_conflict',message);
      if(message==='Task creation outcome is pending reconciliation')throw new ManagementError(409,'task_pending',message);
      if(message==='Task author binding or write permission unavailable')throw new ManagementError(403,'task_authority_unavailable',message);
      throw new ManagementError(503,'task_host_unavailable','The host could not verify this Task request.');
    }
  }
  return [
    {name:'task_authority',description:'Verify the current delegated human GitHub identity and repository write access for this owner endpoint.',input:target,output:authority,mutate:false,run:args=>call('task_authority',args)},
    {name:'task_create',description:'Create one native GitHub Task for work explicitly approved by the bound human owner. Supply the same requestId when retrying that request. GitHub delivers the normal Task event to LEO.',input,output:created,mutate:true,run:async args=>{
      if(args.body.includes('jam-bot:owner-task:') || !parseTaskCard(args.title,args.body,undefined,requireTopic(routes,args.repoId).topic.defaultClass))throw new ManagementError(400,'invalid_task','Invalid Task scope or reserved receipt marker.');
      return call('task_create',args);
    }}
  ];
}
