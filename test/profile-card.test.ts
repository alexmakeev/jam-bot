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

import {parseTaskCard} from '../src/profile-card.js';

test('native Task uses normal text and explicit write scope',()=>{
  assert.deepEqual(parseTaskCard('Summarize status',''),{kind:'development',task:'Summarize status',files:[]});
  assert.deepEqual(parseTaskCard('Read the source','Explain `src/a.ts`.'),{kind:'development',task:'Explain `src/a.ts`.',files:[]});
  assert.deepEqual(parseTaskCard('Implement','Files: src/a.ts, tests/a.test.ts\n\nImplement addition.'),
    {kind:'development',files:['src/a.ts','tests/a.test.ts'],task:'Implement addition.'});
  assert.equal(parseTaskCard('Investigate','What is needed?','consultation')?.kind,'consultation');
  assert.equal(parseTaskCard('Investigate','Class: assignment\n\nWhat is needed?','consultation'),undefined);
  assert.deepEqual(parseTaskCard('Plan','Add a chart.','development'),{kind:'development',task:'Add a chart.',files:[]});
  assert.equal(parseTaskCard('Escape','Files: ../secrets\n\nFix'),undefined);
  assert.equal(parseTaskCard('Ambiguous','Files: a.ts\nFiles: b.ts\n\nFix'),undefined);
});
