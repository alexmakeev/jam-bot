import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {bindWorkspace} from '../src/workspace-binding.js';

test('workspace MCP exposes exactly three read-only tools and rejects writes and protected files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'jam-workspace-protocol-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repository=join(root,'repo'),specifications=join(root,'specs');await mkdir(repository);await mkdir(specifications);
  await writeFile(join(repository,'code.ts'),'export const marker=42;');await writeFile(join(repository,'.env'),'SECRET-CANARY');await writeFile(join(root,'outside'),'OUTSIDE-CANARY');
  const manifest=join(root,'manifest.json');await writeFile(manifest,JSON.stringify({version:1,identity:{revision:'a'.repeat(40),specifications:'b'.repeat(64)},roots:{repository,specifications}}));
  const client=new Client({name:'workspace-test',version:'1'});t.after(()=>client.close());
  await client.connect(new StdioClientTransport({command:process.execPath,args:[new URL('../src/workspace-mcp.js',import.meta.url).pathname,manifest]}));
  const {tools}=await client.listTools();assert.deepEqual(tools.map(tool=>tool.name).sort(),['workspace_list','workspace_read','workspace_search']);assert.ok(tools.every(tool=>tool.annotations?.readOnlyHint===true&&tool.annotations.destructiveHint===false));
  assert.ok(tools.every(tool=>tool._meta?.['anthropic/alwaysLoad']===true));
  const found=await client.callTool({name:'workspace_read',arguments:{root:'repository',path:'code.ts'}});assert.match(JSON.stringify(found),/marker=42/);
  for(const path of ['.env','../outside','/etc/passwd']){
    const result=await client.callTool({name:'workspace_read',arguments:{root:'repository',path}});assert.equal(result.isError,true);assert.doesNotMatch(JSON.stringify(result),/SECRET-CANARY|OUTSIDE-CANARY/);
  }
  assert.equal((await client.callTool({name:'workspace_write',arguments:{root:'repository',path:'code.ts',text:'overwrite'}})).isError,true);
});

test('bound workspace processes enforce the exact member, generation and revision',async t=>{
  const root=await mkdtemp(join(tmpdir(),'jam-workspace-members-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const snapshots=await Promise.all(['a','b'].map(async marker=>{
    const repository=join(root,marker),specifications=join(repository,'specs');
    await mkdir(specifications,{recursive:true});
    await writeFile(join(repository,'code.ts'),marker);
    const manifest={version:1 as const,identity:{revision:marker.repeat(40),specifications:marker.repeat(64)},roots:{repository,specifications}};
    const path=join(root,marker+'.json');
    const binding={session:'lead-'+marker,member:'member-'+marker,challenge:'dispatch-'+marker};
    const digest=await bindWorkspace(path,manifest,binding,join(root,marker+'.log'));
    return {path,binding,digest,manifest,marker};
  }));
  const [first,second]=snapshots as [typeof snapshots[number],typeof snapshots[number]];
  const connect=async(snapshot:typeof first,owner=snapshot.binding,digest=snapshot.digest)=>{
    const client=new Client({name:'binding-test',version:'1'});
    t.after(()=>client.close());
    await client.connect(new StdioClientTransport({command:process.execPath,args:[
      new URL('../src/workspace-mcp.js',import.meta.url).pathname,snapshot.path,digest,owner.session,owner.member,owner.challenge,
    ],stderr:'ignore'}));
    return client;
  };
  for(const snapshot of snapshots){
    const client=await connect(snapshot);
    const call=await client.callTool({name:'workspace_read',arguments:{root:'repository',path:'code.ts'}});
    assert.ok(Array.isArray(call.content));
    const data=JSON.parse((call.content[0] as {text:string}).text);
    assert.deepEqual(data.identity,snapshot.manifest.identity);
    assert.equal(data.text,snapshot.marker);
    assert.equal((await client.callTool({name:'workspace_read',arguments:{root:'repository',path:'../'+(snapshot===first?'b':'a')+'/code.ts'}})).isError,true);
  }
  await assert.rejects(connect(first,second.binding));
  await assert.rejects(connect(first,first.binding,second.digest));
  await assert.rejects(bindWorkspace(first.path,second.manifest,first.binding,join(root,'a.log')),/differs from its saved dispatch/);
});
