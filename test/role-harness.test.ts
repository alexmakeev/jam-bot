import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRoleFiles } from '../src/role-files.js';

test('only approved regular files in the isolated checkout receive developer output',async t=>{
  const root=await mkdtemp(join(tmpdir(),'jam-role-files-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const checkout=join(root,'repo');
  await mkdir(checkout);
  await writeFile(join(root,'outside'),'unchanged');
  await symlink(root,join(checkout,'escaped-dir'));
  await symlink(join(root,'outside'),join(checkout,'escaped-file'));
  function apply(path:string,allowed=[path]) {return applyRoleFiles(checkout,allowed,JSON.stringify({files:[{path,content:'new'}]}));}
  for(const path of ['../outside','escaped-dir/outside','escaped-file','.git/config','/tmp/global']) await assert.rejects(()=>apply(path));
  await assert.rejects(()=>apply('ordinary',[]));
  assert.equal(await readFile(join(root,'outside'),'utf8'),'unchanged');
  await apply('answer.ts');
  assert.equal(await readFile(join(checkout,'answer.ts'),'utf8'),'new');
});

test('exact replacements preserve unrelated source and reject ambiguous or overlapping spans before writing',async t=>{
  const root=await mkdtemp(join(tmpdir(),'jam-role-spans-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const original='head '+'middle '.repeat(3500)+'tail';
  await writeFile(join(root,'page.html'),original);
  const apply=(replacements:{before:string;after:string}[])=>applyRoleFiles(root,['page.html'],JSON.stringify({files:[{path:'page.html',replacements}]}));
  await assert.rejects(apply([{before:'middle',after:'x'}]),/exactly one/);
  await assert.rejects(apply([{before:'head ',after:'new'},{before:'head',after:'other'}]),/Overlapping/);
  assert.equal(await readFile(join(root,'page.html'),'utf8'),original);
  await apply([{before:'tail',after:'new tail'},{before:'head',after:'new head'}]);
  assert.equal(await readFile(join(root,'page.html'),'utf8'),'new '+original.slice(0,-4)+'new tail');
});
