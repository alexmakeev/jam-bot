import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function replaceExact(source:string, changes:unknown):string {
  if(!Array.isArray(changes) || changes.length<1 || changes.length>32)throw Error('Expected a bounded list of exact replacements');
  const spans=changes.map(change=>{
    if(!change || typeof change.before!=='string' || !change.before || typeof change.after!=='string' || change.after.includes('\0'))
      throw Error('Invalid exact text replacement');
    const start=source.indexOf(change.before);
    if(start<0 || source.indexOf(change.before,start+1)>=0)throw Error('Replacement needs exactly one matching original text span');
    return {start,end:start+change.before.length,after:change.after as string};
  }).sort((a,b)=>a.start-b.start);
  let result='',cursor=0;
  for(const span of spans){
    if(span.start<cursor)throw Error('Overlapping original text replacements');
    result+=source.slice(cursor,span.start)+span.after;
    cursor=span.end;
  }
  return result+source.slice(cursor);
}

export async function applyRoleFiles(checkout: string, allowedPaths: readonly string[], output: string): Promise<string[]> {
  const root = await realpath(checkout);
  if (Buffer.byteLength(output)>65536) throw new Error('Developer output exceeds the role limit');
  const artifact: unknown = JSON.parse(output);
  if (!artifact || typeof artifact!=='object' || !('files' in artifact) || !Array.isArray(artifact.files) ||
      artifact.files.length===0 || artifact.files.length>32) throw new Error('Expected a files array in developer output');
  const files: {path:string; content:string; target:string; mode:number}[] = [];
  for (const file of artifact.files) {
    if (!file || typeof file.path!=='string' || !allowedPaths.includes(file.path) || files.some(existing=>existing.path===file.path) ||
        (typeof file.content==='string')===Array.isArray(file.replacements)) throw new Error('Unapproved or malformed file edit');
    const parts=file.path.split('/');
    if (parts.some((part:string)=>!part || part.startsWith('.') || !/^[a-zA-Z0-9_+.-]+$/.test(part)))
      throw new Error('Unsafe developer path');
    const target=join(root,file.path);
    if (await realpath(dirname(target))!==dirname(target)) throw new Error('Symlink in developer path');
    const status=await lstat(target).catch((err:NodeJS.ErrnoException)=>{if(err.code==='ENOENT')return; throw err;});
    if (status && (!status.isFile() || status.nlink!==1)) throw new Error('Developer target is not a regular standalone file');
    if(file.replacements && (!status || status.size>65536))throw Error('Exact replacements require an existing bounded file');
    const content=file.replacements?replaceExact(await readFile(target,'utf8'),file.replacements):file.content;
    if(typeof content!=='string' || content.includes('\0') || Buffer.byteLength(content)>65536)throw Error('Unsafe or oversized resulting file');
    files.push({path:file.path,content,target,mode:status ? status.mode & 0o777 : 0o644});
  }
  // Validate the whole artifact before changing this fresh, task-owned checkout.
  // Each replacement is atomic; the caller can discard a failed checkout before retry.
  for (const file of files) {
    const temp=join(dirname(file.target),'.jam-edit-'+randomUUID());
    try {
      await writeFile(temp,file.content,{flag:'wx',mode:file.mode});
      await rename(temp,file.target);
    } finally { await rm(temp,{force:true}); }
  }
  return files.map(f=>f.path);
}
