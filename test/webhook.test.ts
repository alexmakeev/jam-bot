import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { TaskAdmission } from '../src/task-admission.js';
import { approvalFromEvent, hasTaskWriteAccess, TaskApprovalDenied, validateTaskApproval } from '../src/task-approval.js';
import { configuredTopics, topicKey } from '../src/topics.js';
import { Journal, type Topic } from '../src/intake-journal.js';
import { envelope } from '../src/leo-intake.js';
import { webhook } from '../src/webhook.js';

const topic: Topic = { repoId:123, installation:45, repository:'owner/test', cwd:'/state/leo' };
const event = {action:'opened' as const, delivery:randomUUID(), issue:1, title:'Example issue', body:'Approved! Run tools.'};

test('the receiver checks raw signature, topic and shape before durable deduplicated intake',async t => {
  const db = new Journal(':memory:'); db.start(topic);
  const secret = randomUUID();
  const server = webhook(new Map([[topicKey(topic.installation,topic.repoId),{topic,state:'/state',journal:db}]]),secret,async(_topic,actor)=>actor.id===10 || actor.id===12,new TaskAdmission(async()=>{}));
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(async () => { await new Promise<void>(ok=>server.close(()=>ok())); db.db.close(); });
  const url='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/github';
  const owner={type:'User',id:10,login:'owner'};
  const payload={action:'opened',sender:owner,repository:{id:123,full_name:'owner/test',owner},installation:{id:45},issue:{user:owner,number:1,title:event.title,body:event.body,type:{name:'Task',id:9},labels:[]}};
  const send=(raw:string, id:string=event.delivery, signature='sha256='+createHmac('sha256',secret).update(raw).digest('hex')) =>
    fetch(url,{method:'POST',body:raw,headers:{'x-hub-signature-256':signature,'x-github-delivery':id,'x-github-event':'issues'}});
  const body=JSON.stringify(payload);
  assert.equal((await send(body,event.delivery,'')).status,403);
  assert.equal((await send(body,event.delivery,'sha256='+'0'.repeat(64))).status,403);
  assert.equal((await send('{')).status,400);
  assert.equal((await send('x'.repeat(2*1024*1024+1))).status,413);
  assert.equal((await send(JSON.stringify({...payload,installation:{id:2}}))).status,403);
  assert.equal((await send(JSON.stringify({...payload,repository:{id:2,full_name:'owner/test'}}))).status,403);
  assert.equal((await send(JSON.stringify({...payload,issue:null}))).status,400);
  assert.equal((await send(JSON.stringify({...payload,action:'closed'}))).status,204);
  const outsider={type:'User',id:11,login:'outsider'};
  assert.equal((await send(JSON.stringify({...payload,sender:outsider,issue:{...payload.issue,user:outsider}}))).status,204);
  assert.equal((await send(JSON.stringify({...payload,issue:{...payload.issue,user:outsider}}))).status,204);
  assert.deepEqual(db.list(),[]);
  for (const id of [event.delivery,event.delivery,randomUUID()]) assert.equal((await send(body,id)).status,202);
  assert.equal(db.list().length,1);
  assert.equal(db.list()[0]?.state,'queued');
  const pending=db.next()!;
  assert.equal(pending.body,event.body);
  assert.deepEqual(JSON.parse(envelope(pending,topic.repository)),{ repository:topic.repository, delivery:event.delivery, issue:1 });
  assert.equal(db.next(),undefined);
});

test('restart holds ambiguous dispatch, preserves the session and records explicit resolution',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jam-intake-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'journal');
  let journal=new Journal(path);
  journal.start(topic); const lead=journal.lead();
  journal.enqueue(event); journal.db.close();
  journal=new Journal(path); journal.start(topic); assert.deepEqual(journal.next(),event);
  journal.db.close(); journal=new Journal(path); journal.start(topic);
  const second={...event,issue:2,delivery:randomUUID()};
  journal.enqueue(second);
  assert.equal(journal.next(),undefined);
  assert.deepEqual(journal.lead(),lead);
  assert.equal(journal.list()[0]?.state,'review');
  journal.resolve(event.delivery,'acked','test operator','resume');
  assert.equal(journal.lead().id,lead.id); assert.equal(journal.lead().established,true);
  assert.deepEqual(journal.next(),second);
  journal.fail(second.delivery,'Timed out');
  assert.throws(()=>journal.resolve(second.delivery,'requeue','test operator','unused'));
  journal.resolve(second.delivery,'requeue','test operator','resume');
  assert.deepEqual(journal.next(),second);
  journal.complete({ delivery:second.delivery,issue:second.issue,disposition:'intake_received' });
  assert.equal(journal.list()[1]?.state,'received');
  assert.equal(journal.db.prepare('SELECT COUNT(*) AS n FROM resolutions').get()?.n,2);
  assert.throws(()=>journal.start({...topic,cwd:'/different'}));
  journal.db.close();
});

test('only signed repository-bound dependency events wake eligibility and duplicates do not wake it again',async t=>{
  const previous=process.env.JAM_DEVELOPMENT_V2_REPOSITORIES;
  process.env.JAM_DEVELOPMENT_V2_REPOSITORIES=topic.repository;
  t.after(()=>{if(previous===undefined)delete process.env.JAM_DEVELOPMENT_V2_REPOSITORIES;else process.env.JAM_DEVELOPMENT_V2_REPOSITORIES=previous;});
  const journal=new Journal(':memory:');
  journal.start(topic);
  const secret=randomUUID();
  const server=webhook(new Map([[topicKey(topic.installation,topic.repoId),{topic,state:'/state',journal}]]),secret);
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(async()=>{await new Promise<void>(ok=>server.close(()=>ok()));journal.db.close();});
  const url='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/github';
  const body={action:'blocked_by_added',repository:{id:topic.repoId,full_name:topic.repository},installation:{id:topic.installation}};
  const eventId=randomUUID();
  const send=(payload:object,delivery:string=eventId,valid=true,eventType='issue_dependencies')=>{
    const raw=JSON.stringify(payload);
    const signature=createHmac('sha256',valid?secret:'wrong secret').update(raw).digest('hex');
    return fetch(url,{method:'POST',body:raw,headers:{
      'x-github-event':eventType,'x-github-delivery':delivery,'x-hub-signature-256':'sha256='+signature,
    }});
  };
  assert.equal((await send(body,eventId,false)).status,403);
  assert.equal((await send({...body,installation:{id:99}})).status,403);
  assert.equal((await send(body,'invalid')).status,400);
  assert.equal(journal.dependencyEpoch(),0);
  assert.equal((await send(body)).status,204);
  assert.equal((await send(body,eventId.toUpperCase())).status,204);
  assert.equal(journal.dependencyEpoch(),1);
  const closure={...body,action:'closed',issue:{number:11,state_reason:'not_planned'}};
  assert.equal((await send({...closure,issue:{...closure.issue,state_reason:'completed'}},randomUUID(),true,'issues')).status,204);
  assert.equal(journal.dependencyEpoch(),1);
  const closureId=randomUUID();
  assert.equal((await send(closure,closureId,true,'issues')).status,204);
  assert.equal((await send(closure,closureId,true,'issues')).status,204);
  assert.equal(journal.dependencyEpoch(),2);
  process.env.JAM_DEVELOPMENT_V2_REPOSITORIES='owner/other';
  assert.equal((await send(body,randomUUID())).status,204);
  assert.equal((await send(closure,randomUUID(),true,'issues')).status,204);
  assert.equal(journal.dependencyEpoch(),2);
  assert.deepEqual(journal.list(),[]);
});

test('reconciliation withdraws only pending work and preserves the original receipt',t=>{
  const journal=new Journal(':memory:');journal.start(topic);t.after(()=>journal.db.close());
  const item={...event,action:'task' as const};
  journal.enqueue(item);assert.ok(journal.next());
  const receipt={issue:item.issue,delivery:item.delivery,disposition:'intake_received' as const};
  journal.complete(receipt);
  journal.waitForDependencies(item.delivery,'Dependency: awaiting integration');
  journal.withdrawPendingWorker(item.delivery);
  assert.equal(journal.nextWorker(),undefined);
  assert.equal(journal.list()[0]?.workerState,'abandon');
  assert.deepEqual(JSON.parse(String(journal.list()[0]?.receipt)),receipt);
  assert.throws(()=>journal.withdrawPendingWorker(item.delivery),/No pending work/);
  const other={...item,delivery:randomUUID(),issue:item.issue+1};
  journal.enqueue(other);assert.ok(journal.next());
  journal.complete({...receipt,issue:other.issue,delivery:other.delivery});assert.ok(journal.nextWorker());
  assert.throws(()=>journal.withdrawPendingWorker(other.delivery),/No pending work/);
  assert.equal(journal.list()[1]?.workerState,'running');
});

test('primary paths remain fixed and ambiguous routes fail before starting Claude',()=>{
  const env = { JAM_REPOSITORY:'owner/test', JAM_REPOSITORY_ID:'123', JAM_INSTALLATION_ID:'45',
    JAM_ADDITIONAL_TOPICS:JSON.stringify([{repository:'owner/second',repoId:456,installation:45}]) };
  const configured = configuredTopics('/state',env);
  assert.deepEqual(configured.map(route=>route.topic.cwd),['/state/leo','/state/topics/45/456/leo']);
  assert.throws(()=>configuredTopics('/state',{...env,JAM_ADDITIONAL_TOPICS:'[{"repository":"other/repo","repoId":123,"installation":999}]'}));
  assert.throws(()=>configuredTopics('/state',{...env,JAM_ADDITIONAL_TOPICS:'[{"repository":"owner/TEST","repoId":999,"installation":45}]'}));
});

test('legacy receipts survive schema migration and interrupted worker starts require review', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jam-migration-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'intake.sqlite');
  const legacy=new DatabaseSync(path);
  const session=randomUUID();
  const receipt=JSON.stringify({issue:1,delivery:event.delivery,disposition:'intake_received'});
  legacy.exec(`CREATE TABLE topic(singleton INTEGER PRIMARY KEY,binding TEXT NOT NULL,session TEXT NOT NULL,established INTEGER NOT NULL);
    CREATE TABLE intake(delivery TEXT PRIMARY KEY, issue INTEGER UNIQUE NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,reason TEXT)`);
  legacy.prepare('INSERT INTO topic VALUES(1,?,?,1)').run(JSON.stringify([123,45,'owner/test','/state/leo']),session);
  legacy.prepare("INSERT INTO intake VALUES(?,1,'title','body','received',?,NULL)").run(event.delivery,receipt);
  legacy.close();
  let db=new Journal(path); db.start(topic);
  assert.equal(db.lead().id,session);
  assert.equal(db.list()[0]?.receipt,receipt);
  assert.equal(db.nextWorker(),undefined);
  const locked={...event,action:'task' as const,typeId:9,approvalSource:'typed' as const,delivery:randomUUID(),actorId:11,actorLogin:'owner',authorId:11,authorLogin:'owner'};
  db.enqueue(locked);
  assert.deepEqual(db.next(),locked);
  assert.equal(db.nextWorker(),undefined);
  db.complete({issue:1,delivery:locked.delivery,disposition:'intake_received'});
  db.db.close();
  db=new Journal(path); db.start(topic); assert.deepEqual(db.nextWorker(),locked);
  db.db.close();
  db=new Journal(path); db.start(topic);
  db.enqueue({...locked,delivery:randomUUID()});
  assert.equal(db.list().length,2);
  assert.equal(db.list()[1]?.workerState,'review');
  assert.equal(db.nextWorker(),undefined);
  db.resolveWorker(locked.delivery,'complete','test operator');
  assert.equal(db.nextWorker(),undefined);
  assert.equal(db.list()[1]?.workerState,'complete');
  db.db.close();
});

test('route before approval, verify actor and author, ignore locks, deduplicate opened and typed',async t=>{
  const topics=[topic,{...topic,repoId:456,repository:'owner/other',cwd:'/state/topics/45/456/leo'}];
  const runtime=topics.map(topic=>{
    const journal=new Journal(':memory:'); journal.start(topic);
    return {topic,journal,state:topic.cwd+'/..'};
  });
  const [first,second]=runtime;
  const secret=randomUUID();
  const router=webhook(new Map(runtime.map(route=>[topicKey(route.topic.installation,route.topic.repoId),route])),secret,async(_topic,actor)=>actor.id===10 || actor.id===12,new TaskAdmission(async()=>{}));
  await new Promise<void>(ok=>router.listen(0,'127.0.0.1',ok));
  t.after(async()=>{ await new Promise<void>(ok=>router.close(()=>ok())); runtime.forEach(r=>r.journal.db.close()); });
  const url='http://127.0.0.1:'+(router.address() as AddressInfo).port+'/github';
  const actor={type:'User',id:10,login:'owner'};
  const issue={user:actor,number:1,title:'Manual task',body:'Implement the requested change',locked:false,labels:[{name:'class:development'}]};
  const payload={installation:{id:45},repository:{id:456,owner:actor,full_name:'owner/other'},type:{id:9,name:'Task'},issue,sender:{type:'User',login:'editor',id:12},action:'typed'};
  async function send(data:unknown,id=randomUUID()) {
    const raw=JSON.stringify(data);
    return (await fetch(url,{method:'POST',headers:{'x-github-delivery':id,'x-github-event':'issues',
      'x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(raw).digest('hex')},body:raw})).status;
  }
  assert.equal(await send({...payload,repository:{...payload.repository,id:123}}),403);
  assert.equal(await send({...payload,installation:{id:99}}),403);
  assert.equal(await send({...payload,sender:{...actor,id:11}}),204);
  assert.equal(await send({...payload,issue:{...issue,user:{...actor,id:11}}}),204);
  assert.equal(await send({...payload,action:'locked',issue:{...issue,locked:true}}),204);
  assert.equal(await send({...payload,type:{id:10,name:'Bug'}}),204);
  // GitHub's actual opened delivery contains no type. A later typed delivery must be attributed to its own sender.
  const {type:taskType,...withoutType}=payload;
  assert.equal(await send({...withoutType,sender:actor,action:'opened'}),204);
  assert.equal(await send({...withoutType,issue:{...issue,type:taskType}}),204);
  assert.equal(await send({...payload,issue:{...issue,labels:[{name:'class:development'},{name:'class:consultation'}]}}),422);
  assert.deepEqual(first!.journal.list(),[]); assert.deepEqual(second!.journal.list(),[]);
  const locked=randomUUID();
  assert.equal(await send(payload,locked),202);
  assert.equal(await send(payload),202);
  assert.equal(await send({...withoutType,sender:actor,action:'opened'}),204);
  assert.equal(await send({...payload,sender:actor,repository:{...payload.repository,id:123,full_name:'owner/test'}}),202);
  assert.notEqual(first!.journal.lead().id,second!.journal.lead().id);
  const a=first!.journal.next()!;
  assert.equal(a.action,'task'); assert.equal(first!.journal.nextWorker(),undefined);
  const b=second!.journal.next()!;
  assert.equal(b.delivery,locked); assert.equal(b.actorId,12); assert.equal(b.actorLogin,'editor');
  assert.equal(approvalFromEvent(b).author.id,10); assert.equal(approvalFromEvent(b).kind,'development');
  second!.journal.complete({issue:1,delivery:locked,disposition:'intake_received'});
  assert.deepEqual(second!.journal.nextWorker(),b);
  assert.equal(second!.journal.next(),undefined);
  second!.journal.finishWorker(locked);
  assert.equal(second!.journal.next(),undefined);
  assert.equal(second!.journal.nextWorker(),undefined);
  assert.equal(first!.journal.list().length,1);
});

test('a text-producing subagent cannot satisfy native teammate evidence',async t=>{
  const {teammateReceipt,mailboxReceipt}=await import('../src/native-teammate.js');
  const {mkdir,writeFile,appendFile,readFile}=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'jam-team-evidence-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const session=randomUUID(), name='developer-test', cwd='/state/leo', handle='native-handle';
  const challenge=randomUUID(), answer=challenge+':12', team='session-'+session.slice(0,8);
  const prefix=join(root,'projects','-state-leo',session);
  await mkdir(join(prefix,'subagents'),{recursive:true});
  const msg=(type:string,content:unknown)=>JSON.stringify({type,sessionId:session,message:{content}})+'\n';
  await writeFile(prefix+'.jsonl',msg('assistant',[{type:'tool_use',name:'Agent',id:'call',input:{name,subagent_type:'jam-developer',prompt:challenge}}])+
    msg('user',[{type:'tool_result',tool_use_id:'call',content:[{text:'Spawned successfully.\nagent_id: '+handle}]}])+
    msg('user','Another Claude session sent a message:\n<agent-message from="'+name+'">\n'+answer+'\n</agent-message>'));
  const worker=join(prefix,'subagents','agent-'+handle+'.jsonl');
  await writeFile(worker,msg('assistant',[{type:'text',text:answer}]));
  assert.equal(await teammateReceipt(root,cwd,session,name,challenge,answer),undefined);
  const teamDir=join(root,'teams',team);
  await mkdir(teamDir,{recursive:true});
  await writeFile(join(teamDir,'config.json'),JSON.stringify({leadSessionId:session,members:[{name,agentId:name+'@'+team,backendType:'in-process',cwd}]}));
  assert.equal(await teammateReceipt(root,cwd,session,name,challenge,answer),undefined);
  await writeFile(worker,msg('assistant',[{type:'tool_use',name:'SendMessage',input:{to:'main',message:answer}}]));
  assert.equal((await teammateReceipt(root,cwd,session,name,challenge,answer))?.developer,handle);
  const completeLog=await readFile(prefix+'.jsonl','utf8');
  await writeFile(prefix+'.jsonl',completeLog.trimEnd());
  assert.equal((await teammateReceipt(root,cwd,session,name,challenge,answer))?.developer,handle);
  await appendFile(prefix+'.jsonl','\n{"type":');
  assert.equal((await teammateReceipt(root,cwd,session,name,challenge,answer))?.developer,handle);
  await writeFile(prefix+'.jsonl',completeLog);
  const markdown='# Verified spec\n\nKeep the final newline.\n';
  const roleAnswer=challenge+'\n'+markdown;
  await writeFile(worker,msg('assistant',[{type:'tool_use',name:'SendMessage',input:{to:'main',message:roleAnswer}}]));
  const query={config:root,cwd,session,name,challenge,agentType:'jam-developer'};
  assert.equal(await mailboxReceipt(query),undefined);
  await appendFile(prefix+'.jsonl',msg('user','Another Claude session sent a message:\n<agent-message from="'+name+'">\n'+roleAnswer+'\n</agent-message>'));
  assert.equal((await mailboxReceipt(query))?.output,markdown);
  const teamInit=msg('assistant',[{type:'tool_use',name:'Agent',id:'call',input:{name,subagent_type:'jam-developer',prompt:challenge}}])+
    msg('user',[{type:'tool_result',tool_use_id:'call',content:[{text:'agent_id: '+handle}]}]);
  const idle=(from:string,result:string)=>msg('user','Another Claude session sent a message:\n<teammate-message teammate_id="'+from+'" color="blue">\n'+
    JSON.stringify({type:'idle_notification',from,idleReason:'available',result})+'\n</teammate-message>');
  const resultTurn=(text:string)=>JSON.stringify({type:'assistant',sessionId:session,message:{content:[{type:'text',text}],stop_reason:'end_turn'}})+'\n';
  await writeFile(worker,resultTurn(roleAnswer));
  await writeFile(prefix+'.jsonl',teamInit+idle('other',roleAnswer)+idle(name,roleAnswer+'modified'));
  assert.equal(await mailboxReceipt(query),undefined);
  await appendFile(prefix+'.jsonl',idle(name,roleAnswer));
  assert.equal((await mailboxReceipt(query))?.output,markdown);
  const long=roleAnswer+'z'.repeat(8000);
  const clipped=long.slice(0,4000)+'\n[result truncated — ask the agent for the rest via SendMessage]';
  await writeFile(worker,resultTurn(long));
  await writeFile(prefix+'.jsonl',teamInit+idle(name,clipped));
  assert.equal((await mailboxReceipt(query))?.output,long.slice(challenge.length+1));
  await rm(join(root,'teams',team),{recursive:true});
  const meta={name,teamName:team,taskKind:'in_process_teammate',customAgentType:'jam-developer',spawnedAgentType:'jam-developer'};
  await writeFile(worker.replace(/\.jsonl$/,'.meta.json'),JSON.stringify(meta));
  assert.equal(await mailboxReceipt(query),undefined);
  await appendFile(worker,JSON.stringify({type:'system',sessionId:session,cwd,agentId:handle})+'\n');
  assert.equal((await mailboxReceipt(query))?.output,long.slice(challenge.length+1));
  await appendFile(worker,resultTurn(long+'ambiguous'));
  await assert.rejects(mailboxReceipt(query),/Ambiguous/);
  await writeFile(prefix+'.jsonl',msg('assistant',[{type:'tool_use',name:'Agent',id:'call',input:{name,subagent_type:'jam-developer',prompt:challenge}}])+
    msg('user',[{type:'tool_result',tool_use_id:'call',is_error:true,content:'An interrupted invocation with private text'}]));
  await assert.rejects(mailboxReceipt(query),/declined or interrupted by the harness; reconcile before another execution/);

});


test('Task approval uses immutable identities and effective collaborator write permission',async()=>{
  const actor={type:'User',id:1234,login:'editor'};
  const permitted=(permission:string,user=actor)=>hasTaskWriteAccess(topic,actor,async path=>
    path.includes('/collaborators/')?{user,permission,role_name:'custom'}:{id:topic.repoId});
  assert.equal(await permitted('write'),true);
  assert.equal(await permitted('admin'),true);
  assert.equal(await permitted('read'),false);
  assert.equal(await permitted('write',{...actor,id:99}),false);
  assert.equal(await hasTaskWriteAccess(topic,{...actor,type:'Bot'},async()=>{throw Error('Unexpected provider call');}),false);
});


test('Task admission automatically locks only an unchanged scope from two currently authorized humans',async()=>{
  const actor={type:'User',login:'approver',id:45}, author={type:'User',login:'author',id:46};
  const approval={actor,author,title:'Design change',body:'Current scope',typeId:7};
  const issue={number:11,user:author,state:'open',locked:false,labels:[],type:{id:7,name:'Task'},title:approval.title,body:approval.body};
  let actorAccess='write', authorAccess='write', locks=0;
  const clients={
    read:async()=>async(path:string)=>{
      if(path.endsWith('/issues/11'))return {...issue};
      if(path.endsWith('/approver/permission'))return {user:actor,permission:actorAccess};
      if(path.endsWith('/author/permission'))return {user:author,permission:authorAccess};
      return {id:topic.repoId};
    },
    write:async()=>async(path:string,method?:string)=>{assert.equal(path,'/issues/11/lock');assert.equal(method,'PUT');++locks;issue.locked=true;},
  };
  await assert.rejects(validateTaskApproval(topic,11,approval,false,clients));
  await validateTaskApproval(topic,11,approval,true,clients);
  assert.equal(locks,1);
  await validateTaskApproval(topic,11,approval,true,clients);assert.equal(locks,1);
  issue.body='Modified';await assert.rejects(validateTaskApproval(topic,11,approval,false,clients));
  issue.body=approval.body;actorAccess='read';await assert.rejects(validateTaskApproval(topic,11,approval,false,clients));
  actorAccess='write';authorAccess='read';await assert.rejects(validateTaskApproval(topic,11,approval,false,clients));
  authorAccess='write';issue.type.name='Feature';await assert.rejects(validateTaskApproval(topic,11,approval,false,clients));
});

test('signed admission protects independent cards immediately and recovers a durable intent after a lock-side failure',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jam-admission-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'intake.sqlite');
  let journal=new Journal(path); journal.start(topic);
  const event={delivery:randomUUID(),issue:12,title:'Change',body:'Approved scope',action:'task' as const,approvalSource:'typed' as const,
    typeId:44,actorId:10,actorLogin:'owner',authorId:10,authorLogin:'owner'};
  // A running assignment blocks JAM's native consumer but must not defer the next task's lock.
  journal.enqueue({...event,issue:11,delivery:randomUUID()});
  assert.ok(journal.next());
  let providerLocked=false, mutations=0;
  const interrupted=new TaskAdmission(async()=>{
    if(!providerLocked){providerLocked=true; mutations++;}
    throw Error('Connection failed after GitHub accepted lock');
  });
  await assert.rejects(interrupted.admit({topic,state:dir,journal},event));
  assert.equal(mutations,1);
  assert.equal(journal.pendingAdmissions()[0]?.delivery,event.delivery);
  assert.equal(journal.next(),undefined);
  journal.db.close(); journal=new Journal(path);journal.start(topic);
  t.after(()=>journal.db.close());
  const recovered=new TaskAdmission(async(_topic,issue,approval)=>{
    assert.equal(issue,12);assert.equal(approval.actor.id,10);assert.ok(providerLocked);
  });
  await recovered.recover([{topic,state:dir,journal}]);
  assert.equal(journal.list().find(row=>row.issue===12)?.state,'queued');
  assert.equal(journal.list().find(row=>row.issue===12)?.lockVerified,1);
  assert.equal(await recovered.admit({topic,state:dir,journal},{...event,delivery:randomUUID()}),202);
  assert.equal(await recovered.admit({topic,state:dir,journal},{...event,delivery:randomUUID(),actorId:22}),409);
  assert.equal(await recovered.admit({topic,state:dir,journal},{...event,delivery:randomUUID(),body:'Replaced'}),409);
  assert.equal(mutations,1);
});

test('an already closed or retyped issue is rejected before JAM and concurrent redelivery shares one lock',async t=>{
  const journal=new Journal(':memory:');journal.start(topic);t.after(()=>journal.db.close());
  const runtime={topic,journal,state:'/state'};
  const approval={...event,action:'task' as const,approvalSource:'typed' as const,typeId:44,authorId:10,authorLogin:'owner',actorId:10,actorLogin:'owner'};
  let calls=0;
  const admission=new TaskAdmission(async()=>{
    calls++;
    await Promise.resolve();
    throw new TaskApprovalDenied('Native Task type, open state or approved scope changed');
  });
  assert.deepEqual(await Promise.all([admission.admit(runtime,approval),admission.admit(runtime,{...approval,delivery:randomUUID()})]),[409,409]);
  assert.equal(calls,1); assert.equal(journal.next(),undefined);
  assert.equal(journal.list()[0]?.state,'rejected');
});

test('detect a current native model refusal without replaying it or blaming another session',async t=>{
  const {stageRefused}=await import('../src/native-teammate.js');
  const {writeFile}=await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'jam-role-refusal-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'session.jsonl'),at=Date.now();
  const row={type:'assistant',sessionId:'lead',isApiErrorMessage:true,message:{stop_reason:'refusal'},timestamp:new Date(at).toISOString()};
  await writeFile(path,'x'.repeat(70000)+'\n'+JSON.stringify(row)+'\n');
  assert.equal(await stageRefused(path,'lead',at),true);
  assert.equal(await stageRefused(path,'other',at),false);
  assert.equal(await stageRefused(path,'lead',at+1),false);
});
