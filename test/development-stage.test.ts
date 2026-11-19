import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pinDevelopmentStage} from '../src/development-stage.js';
test('a Development step recovers its original input and snapshot despite changed excerpts',async t=>{
  const state=await mkdtemp(join(tmpdir(),'jam-pinned-stage-'));t.after(()=>rm(state,{recursive:true,force:true}));let calls=0;
  const create=async()=>{calls++;return {manifestPath:join(state,'manifest.json'),identity:{revision:'a'.repeat(40),specifications:'b'.repeat(64)}};};
  const first=await pinDevelopmentStage(state,1,'architect','draft','approval','Original excerpts',create);
  const second=await pinDevelopmentStage(state,1,'architect','draft','approval','Changed excerpts',create);
  assert.deepEqual(second,first);assert.equal(calls,1);
  await assert.rejects(pinDevelopmentStage(state,1,'architect','draft','different approval','Changed excerpts',create),/approval changed/);
});
