import test from 'node:test';
import assert from 'node:assert/strict';
import {selectEnvironmentRecipe,signEnvironment,validEnvironmentSignature} from '../src/environment-wire.js';
import {runEnvironment,withEnvironmentAuthority,withoutEnvironmentAuthority} from '../src/environment-runner.js';

test('environment command requires management authority and signatures bind the full payload and direction',async()=>{
  await assert.rejects(runEnvironment({serverId:'example',repoId:1,environment:'staging',action:'deploy'}),/authenticated/);
  await withEnvironmentAuthority('owner',()=>withoutEnvironmentAuthority(async()=>{
    await Promise.resolve();
    await assert.rejects(runEnvironment({serverId:'example',repoId:1,environment:'staging',action:'stop'}),/authenticated/);
  }));
  const body=JSON.stringify({repoId:1,environment:'staging',action:'stop'});
  const signature=signEnvironment('operator','request',body);
  assert.ok(validEnvironmentSignature('operator','request',body,signature));
  assert.equal(validEnvironmentSignature('other','request',body,signature),false);
  assert.equal(validEnvironmentSignature('operator','response',body,signature),false);
  assert.equal(validEnvironmentSignature('operator','request',body.replace('staging','other'),signature),false);
});

test('exact and templated recipes bind repository IDs and reject ambiguous instances',()=>{
  const template={repoId:1,environmentPrefix:'preview-'}, exact={repoId:1,environment:'preview-main'};
  assert.equal(selectEnvironmentRecipe([template,exact],1,'preview-main'),exact);
  assert.equal(selectEnvironmentRecipe([template],1,'preview-new'),template);
  assert.equal(selectEnvironmentRecipe([template],2,'preview-new'),undefined);
  assert.equal(selectEnvironmentRecipe([template],1,'preview-'),undefined);
  assert.throws(()=>selectEnvironmentRecipe([template,{repoId:1,environmentPrefix:'preview-pr-'}],1,'preview-pr-421'));
  assert.throws(()=>selectEnvironmentRecipe([{...template,...exact}],1,'preview-new'));
});
