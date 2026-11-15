import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReleaseRoutes,selectRoute,due,repositoryRoutes} from '../scripts/macos/release-routes.mjs';
const header='## Release routes\n\n| Source | Channel | Destination | Trigger | Checks | Acceptance |\n| --- | --- | --- | --- | --- | --- |\n';
const row='| branch:dev | nightly | sum-nightly | daily@12:00Z | unit, browser, live | 0m |';
const policy={repoId:12,profileRef:'jam-bot-profile',channels:{nightly:{sources:['branch:dev'],triggers:['daily'],destinations:['sum-nightly'],requiredChecks:['unit','browser','live']}}};

test('repository routes are limited to host-approved sources, targets, checks and trigger classes',()=>{
  const r=parseReleaseRoutes(header+row);
  assert.equal(selectRoute(r,policy,'nightly').destination,'sum-nightly');
  for(const [key,value] of [['source','branch:main'],['trigger','checks'],['destination','production'],['checks',['unit']]]){
    assert.throws(()=>selectRoute([{...r[0],[key]:value}],policy,'nightly'));
  }
  assert.throws(()=>parseReleaseRoutes(header+row.replace('nightly | sum','stable | sum')));
  assert.throws(()=>parseReleaseRoutes(header+row+'\n'+row));
  assert.throws(()=>parseReleaseRoutes(header+row.replace('branch:dev','channel:untested')));
  assert.throws(()=>parseReleaseRoutes(header+row.replace('unit, browser, live','script.sh')));
  assert.throws(()=>selectRoute(r,{channels:{nightly:{...policy.channels.nightly,minimumMinutes:1}}},'nightly'));
});

test('daily release takes the latest eligible source after the configured UTC slot; approval stays explicit',()=>{
  const [route]=parseReleaseRoutes(header+row);
  const at=s=>Date.parse('2026-11-15T'+s+'Z');
  assert.equal(due(route,{sourceReadyAt:at('06:00'),now:at('11:59')}),false);
  assert.equal(due(route,{sourceReadyAt:at('12:01'),now:at('12:02')}),false);
  assert.equal(due(route,{sourceReadyAt:at('06:00'),now:at('12:00')}),true);
  assert.equal(due({...route,trigger:'approval'},{sourceReadyAt:0,now:10}),false);
  assert.equal(due({...route,trigger:'approval'},{sourceReadyAt:0,now:10,approved:true}),true);
});

test('profile reader uses the configured topic and reads VALUES at the resolved immutable profile commit',async()=>{
  const sha='b'.repeat(40),calls=[];
  const execute=async(_,args)=>{const path=args.at(-1);calls.push(path);const result=path.includes('/contents/')?
    {type:'file',encoding:'base64',size:256,content:Buffer.from(header+row).toString('base64')}:path.includes('/commits/')?{sha}:{id:12};
    return {stdout:JSON.stringify(result)};
  };
  const result=await repositoryRoutes('owner/repo',policy,execute);
  assert.equal(result.revision,sha);assert.equal(calls.at(-1),'repos/owner/repo/contents/.jam-bot/VALUES.md?ref='+sha);
  await assert.rejects(repositoryRoutes('owner/repo',{...policy,repoId:99},execute));
});
