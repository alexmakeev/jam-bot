import {execFile,spawn,type SpawnOptionsWithoutStdio} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';

const run=promisify(execFile);
export const nativeLeadBusyCode=75;
const lockPath=(state:string)=>join(state,'native-lead.lock');
const lockArgs=(state:string)=>['-n','-E',String(nativeLeadBusyCode),'-F',lockPath(state)];

export async function nativeLeadOccupied(state:string):Promise<boolean>{
  await mkdir(state,{recursive:true,mode:0o700});
  try{
    await run('flock',[...lockArgs(state),'true'],{timeout:5000});
    return false;
  }catch(error){
    if((error as {code?:number}).code===nativeLeadBusyCode)return true;
    throw Error('Native lead ownership could not be reconciled');
  }
}

export async function startNativeLead(state:string,args:string[],options:SpawnOptionsWithoutStdio){
  const invocation=await nativeLeadCommand(state,'script',args);
  return spawn('flock',invocation,{...options,stdio:['pipe','ignore','ignore']});
}

export async function nativeLeadCommand(state:string,command:string,args:string[]){
  await mkdir(state,{recursive:true,mode:0o700});
  return [...lockArgs(state),command,...args];
}
