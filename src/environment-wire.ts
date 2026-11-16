import { createHmac, timingSafeEqual } from 'node:crypto';

export type EnvironmentAction = {
  serverId:string;repoId:number;environment:string;action:'deploy'|'status'|'stop';revision?:string;
  binding?:'existing-local';includePublication?:boolean;tier?:'development'|'staging'|'stable';config?:{LOG_LEVEL?:'debug'|'info'|'warn'|'error'};secretRefs?:string[];appVariables?:Record<string,string>;endpoint?:{address:'127.0.0.1';port:number};
};
export type StaticPublication = {url:string;manifestSha256:string;objectCount:number;verifiedAt:string;cacheVerified:true};
export interface PreviewObservation {
  web:{url:string;status:number|null};api?:{url:string;status:number|null};
  dependency?:{project:string;service:string;running:boolean;healthy:boolean;containerId:string|null};
}
export type EnvironmentResult = {observation?:PreviewObservation;publication?:StaticPublication;environment:string;running:boolean;healthy:boolean;revision:string|null;image:string|null;endpoint?:{address:string;port:number}|null};
export function signEnvironment(token:string,channel:'request'|'response',body:string) {
  return createHmac('sha256',token).update('jam-environment-v1/'+channel+'\n').update(body).digest('hex');
}
export function validEnvironmentSignature(token:string,channel:'request'|'response',body:string,sig:unknown) {
  return typeof sig==='string' && /^[a-f0-9]{64}$/.test(sig) &&
    timingSafeEqual(Buffer.from(signEnvironment(token,channel,body),'hex'),Buffer.from(sig,'hex'));
}

interface RecipeSelector {repoId:number;environment?:string;environmentPrefix?:string}
export function selectEnvironmentRecipe<T extends RecipeSelector>(recipes:T[],repoId:number,name:string):T|undefined {
  const matches=recipes.filter(recipe=>recipe.repoId===repoId);
  for(const recipe of matches){
    const exact=recipe.environment!==undefined,prefix=recipe.environmentPrefix!==undefined;
    if(exact===prefix || (exact && !/^[a-z][a-z0-9-]{0,39}$/.test(recipe.environment!)) ||
        (prefix && !/^[a-z][a-z0-9-]{0,34}-$/.test(recipe.environmentPrefix!)))throw Error('Invalid environment recipe selector');
  }
  const exact=matches.filter(r=>r.environment===name);
  const selected=exact.length?exact:matches.filter(r=>r.environmentPrefix && name.length>r.environmentPrefix.length && name.startsWith(r.environmentPrefix));
  if(selected.length>1)throw Error('Ambiguous host environment recipe');
  return selected[0];
}
