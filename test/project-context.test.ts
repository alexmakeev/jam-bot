import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectContext } from '../src/developer-profile.js';
import { applyRoleFiles } from '../src/role-files.js';

test('architect-referenced implementation and adjacent tests are readable without granting edits', async () => {
  const tree=await realpath(await mkdtemp(join(tmpdir(),'jam-project-context-')));
  try {
    await mkdir(join(tree,'src'));await mkdir(join(tree,'tests'));
    await writeFile(join(tree,'src/sum.ts'),'export const sum = (values: number[]) => values.reduce((x,y) => x+y,0);');
    await writeFile(join(tree,'tests/sum.test.ts'),"import { sum } from '../src/sum.ts';");
    await writeFile(join(tree,'src/unrelated.ts'),'private-unrelated-source');
    execFileSync('git',['init','--quiet',tree]);execFileSync('git',['-C',tree,'add','.']);
    const files=['tests/sum.large.test.ts'];
    const brief=await projectContext(tree,files,'Check src/sum.ts and match tests/sum.test.ts.');
    assert.match(brief,/export const sum =/);assert.match(brief,/import \{ sum \} from/);
    assert.doesNotMatch(brief,/private-unrelated-source/);
    await assert.rejects(applyRoleFiles(tree,files,JSON.stringify({files:[{path:'src/sum.ts',content:'unexpected edit'}]})));
  } finally {await rm(tree,{recursive:true,force:true});}
});
