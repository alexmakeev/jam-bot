import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfileCard, formatProfileCard, type ProfileCard } from '../src/profile-card.js';

test('owner-approved profile envelope has one bounded task and an explicit file scope',()=>{
  for (const kind of ['development','assignment','consultation'] as const) {
    const card:ProfileCard = {kind,files:kind==='development'?['src/sum.ts','tests/sum.test.ts']:[],task:'Answer this approved question.'};
    const body = formatProfileCard(card);
    assert.deepEqual(parseProfileCard(body),card);
    assert.equal(parseProfileCard(body.replace('I approve','I might approve')),undefined);
  }
  for (const file of ['../secret','.git/config','x/../../a','./target','foo//bar','/etc/passwd']) {
    assert.throws(()=>formatProfileCard({kind:'development',task:'test',files:[file]}));
  }
  assert.throws(()=>formatProfileCard({kind:'assignment',task:'test',files:['src/a']}));
});
