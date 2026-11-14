import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { signEnvironment, validEnvironmentSignature, type EnvironmentAction, type EnvironmentResult } from './environment-wire.js';

const authority=new AsyncLocalStorage<string>();
export function withEnvironmentAuthority<T>(bearer:string,action:()=>T):T {return authority.run(bearer,action);}
export function withoutEnvironmentAuthority<T>(action:()=>T):T {return authority.exit(action);}
export async function runEnvironment(input:EnvironmentAction,signal?:AbortSignal):Promise<EnvironmentResult>{
  const token=authority.getStore();
  if(!token)throw Error('Environment changes require an authenticated management request');
  const root=process.env.JAM_DEPLOY_EXCHANGE;
  if(!root)throw Error('Host environment runner is not configured');
  const id=randomUUID(), body=JSON.stringify({id,at:Date.now(),...input});
  const path=join(root,id),response=path+'.response';
  await writeFile(path+'.tmp',JSON.stringify({body,signature:signEnvironment(token,'request',body)}),{mode:0o600,flag:'wx'});
  await rename(path+'.tmp',path+'.request');
  const until=Date.now()+170000;
  while(Date.now()<until){
    signal?.throwIfAborted();
    const raw=await readFile(response,'utf8').catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return '';});
    if(raw){
      if(raw.length>8192)throw Error('Invalid host response size');
      const msg=JSON.parse(raw);
      if(typeof msg.body!=='string'||!validEnvironmentSignature(token,'response',msg.body,msg.signature))throw Error('Host response signature invalid');
      const reply=JSON.parse(msg.body);
      if(reply.id!==id)throw Error('Mismatched host response');
      await rm(response);
      if(!reply.ok)throw Error(String(reply.error));
      return reply.value;
    }
    await delay(200,undefined,{signal});
  }
  throw Error('Environment action is still unconfirmed; inspect runtime status');
}
