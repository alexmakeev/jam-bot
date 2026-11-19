import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {managementAlias} from './management-environments.js';
import {runSecretOperation} from './environment-runner.js';
import {ManagementError,requireServer,requireTopic,targetFields,type ManagementOperation} from './management-contract.js';
import type {TopicRuntime} from './topics.js';

const alias=managementAlias;
const target=z.strictObject({...targetFields,environment:alias});
const entry=z.strictObject({alias,present:z.boolean(),masked:z.string().nullable()});
const setResult=z.strictObject({requestId:z.uuid(),alias,updated:z.literal(true)});
const getResult=z.strictObject({secrets:z.array(entry)});

export function secretOperations(routes:ReadonlyMap<string,TopicRuntime>,serverId:string,run=runSecretOperation):ManagementOperation[]{
  function check(input:z.infer<typeof target>){
    requireServer(serverId,input.serverId);
    requireTopic(routes,input.repoId);
  }
  async function invoke(input:Parameters<typeof runSecretOperation>[0],value?:string){
    try{return await run(input,value);}
    catch{throw new ManagementError(503,'secret_operation_failed','The host could not confirm the secret operation.');}
  }
  return [
    {name:'secret_set',description:'Write or replace one environment secret. Values are never returned. Reuse requestId when retrying.',mutate:true,
      input:target.extend({alias,value:z.string().min(1).refine(v=>Buffer.byteLength(v)<=65536,'Secret is too large'),requestId:z.uuid().optional()}),
      output:setResult,run:async input=>{
        check(input);
        const {value,...metadata}=input;
        return setResult.parse(await invoke({...metadata,action:'secret-set',requestId:input.requestId??randomUUID()},value));
      }},
    {name:'secret_get',description:'Get one secret or list the selected environment secrets with masked previews only.',mutate:false,
      input:target.extend({alias:alias.optional()}),output:getResult,run:async input=>{
        check(input);
        return getResult.parse(await invoke({...input,action:'secret-get'}));
      }}
  ];
}
