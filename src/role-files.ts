import { lstat, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function applyRoleFiles(checkout: string, allowedPaths: readonly string[], output: string): Promise<string[]> {
  const root = await realpath(checkout);
  if (Buffer.byteLength(output)>65536) throw new Error('Developer output exceeds the role limit');
  const artifact: unknown = JSON.parse(output);
  if (!artifact || typeof artifact!=='object' || !('files' in artifact) || !Array.isArray(artifact.files) ||
      artifact.files.length===0 || artifact.files.length>32) throw new Error('Expected a files array in developer output');
  const files: {path:string; content:string; target:string; mode:number}[] = [];
  for (const file of artifact.files) {
    if (!file || typeof file.path!=='string' || typeof file.content!=='string' || !allowedPaths.includes(file.path) ||
        files.some(existing=>existing.path===file.path) || file.content.includes('\0')) throw new Error('Unapproved or malformed file edit');
    const parts=file.path.split('/');
    if (parts.some((part:string)=>!part || part.startsWith('.') || !/^[a-zA-Z0-9_+.-]+$/.test(part)))
      throw new Error('Unsafe developer path');
    const target=join(root,file.path);
    if (await realpath(dirname(target))!==dirname(target)) throw new Error('Symlink in developer path');
    const status=await lstat(target).catch((err:NodeJS.ErrnoException)=>{if(err.code==='ENOENT')return; throw err;});
    if (status && (!status.isFile() || status.nlink!==1)) throw new Error('Developer target is not a regular standalone file');
    files.push({path:file.path,content:file.content,target,mode:status ? status.mode & 0o777 : 0o644});
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
