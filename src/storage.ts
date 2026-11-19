import { mkdir, readFile, writeFile, rename, link, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Card, Owner, ProjectSource } from './model.js';
export const key = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 20);
export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
}
export async function createJson(path: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
}
export async function claimJson(path:string,value:unknown):Promise<boolean>{
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temporary=path+'.'+randomUUID();
  try{
    await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
    await link(temporary,path);
    return true;
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='EEXIST')return false;
    throw error;
  }finally{await rm(temporary,{force:true});}
}
/** Trusted local fixture, NOT a GitHub approval verifier or cross-host authority. */
export class FixtureSource implements ProjectSource {
  constructor(readonly root: string) {}
  async readCard(id: string): Promise<Card> { return readJson(join(this.root, 'cards', `${key(id)}.json`)); }
  async readOwner(uri: string): Promise<Owner> { return readJson(join(this.root, 'owners', `${key(uri)}.json`)); }
}
export const assignmentPath = (root: string, id: string): string => join(root, 'assignments', key(id), 'assignment.json');
export const checkpointPath = (root: string, id: string): string => join(root, 'assignments', key(id), 'checkpoint.json');
