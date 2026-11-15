import test from 'node:test';
import assert from 'node:assert/strict';
import {projectRecipes,testCandidate} from '../scripts/macos/profile-recipes.mjs';

test('legacy operator settings retain direct Node tests for every configured repository',()=>{
  const result=projectRecipes({repositories:['o/a','o/b'],image:'sha256:pinned'});
  assert.deepEqual(result,{
    'o/a':{image:'sha256:pinned',recipe:'node-strip'},
    'o/b':{image:'sha256:pinned',recipe:'node-strip'},
  });
});

test('mixed repository recipes preserve their separate discovery roots',async()=>{
  const projects=projectRecipes({projects:{
    'o/a':{image:'image-a',recipe:'node-strip'},
    'o/b':{image:'image-b',recipe:'typescript-build'}
  }});
  await assert.rejects(testCandidate({project:projects['o/a'],files:['test/a.test.mjs']}),/No tracked tests/);
  await assert.rejects(testCandidate({project:projects['o/b'],files:['test/a.test.mjs']}),/Missing tsconfig/);
  await assert.rejects(testCandidate({project:projects['o/b'],files:['tsconfig.json','tests/a.test.ts']}),/No tracked tests/);
  assert.throws(()=>projectRecipes({projects:{'o/a':{image:'image-a',recipe:'npm-from-card'}}}),/Invalid trusted/);
});

test('calculator browser validation accepts only a pinned image on the selected build recipe',()=>{
  const config=(recipe,calculatorBrowserImage)=>({projects:{'o/a':{image:'base',recipe,calculatorBrowserImage}}});
  assert.throws(()=>projectRecipes(config('typescript-build','calculator:latest')),/Invalid calculator browser/);
  const image='sha256:'+'a'.repeat(64);
  assert.throws(()=>projectRecipes(config('node-strip',image)),/Invalid calculator browser/);
  assert.equal(projectRecipes(config('typescript-build',image))['o/a'].calculatorBrowserImage,image);
});

test('calculator acceptance selects only registered checks with a positive issue number',()=>{
  const project={image:'base',recipe:'typescript-build',calculatorBrowserImage:'sha256:'+'a'.repeat(64)};
  const load=calculatorSpecCards=>projectRecipes({projects:{'o/a':{...project,calculatorSpecCards}}});
  assert.throws(()=>load({dragons:0}),/Invalid calculator acceptance/);
  assert.throws(()=>load({command:21}),/Invalid calculator acceptance/);
  assert.deepEqual(load({reset:22})['o/a'].calculatorSpecCards,{reset:22});
});

test('Sandbox clear action is selected only by a positive issue number on an enabled browser recipe',()=>{
  const project={image:'base',recipe:'node-strip',sumBrowserImage:'sha256:'+'7'.repeat(64),runningTotalsCard:7};
  const load=p=>projectRecipes({projects:{'o/sandbox':p}});
  assert.doesNotThrow(()=>load({...project,clearTotalsCard:8}));
  assert.throws(()=>load({...project,clearTotalsCard:'8'}),/Invalid clear totals/);
  assert.throws(()=>load({...project,clearTotalsCard:8,sumBrowserImage:undefined}),/Invalid clear totals/);
});
