import {readFile,stat,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
export async function recoverValidation(dir,id,{inspect,stop,replay,now=Date.now()}){
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid validation recovery identity');
  const started=(await stat(join(dir,'request.json'))).mtimeMs;
  const containers=[];
  for(const name of ['jam-check-'+id,'jam-check-'+id+'-browser']){
    const state=await inspect(name);
    if(state?.running){
      if(state.owner!==name)throw Error('Validation container ownership requires reconciliation');
      containers.push(name);
    }
  }
  if(containers.length&&now-started<120000)return 'waiting';
  for(const name of containers)await stop(name);
  const receipt=join(dir,'validation-recovery.json');
  const previous=await readFile(receipt,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
  const staged=await readFile(receipt+'.tmp','utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
  if(previous||staged)throw Error('Read-only validation recovery budget exhausted');
  const temporary=receipt+'.tmp';await writeFile(temporary,JSON.stringify({attempt:1,startedAt:now}),{mode:0o600,flag:'wx'});await rename(temporary,receipt);
  await replay();return 'replayed';
}
