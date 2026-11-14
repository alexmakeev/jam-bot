import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { managementTransport, type ManagementHandler, type ManagementOperations } from '../src/management-transport.js';
import { ManagementError } from '../src/management-contract.js';
import { cli } from '../src/management-cli.js';

const token=randomUUID(), uri='https://github.com/example/project';
async function fixture() {
  let id=randomUUID(), mutations=0;
  const topicSchema=z.object({repoId:z.number(),sourceUri:z.string()});
  const operations:ManagementOperations={
    operations:[
      {name:'list_topics',description:'List connected topics',input:z.strictObject({}),output:z.object({serverId:z.uuid(),topics:z.array(topicSchema)}),mutate:false},
      {name:'configure_topic',description:'Update the selected topic',input:z.strictObject({serverId:z.uuid(),repoId:z.int()}),output:z.object({changed:z.boolean()}),mutate:true}
    ],
    async invoke(name,input){
      if(name==='list_topics')return {serverId:id,topics:[{repoId:7,sourceUri:uri}]};
      if((input as any).serverId!==id)throw new ManagementError(409,'wrong_server','Wrong destination');
      mutations++;return {changed:true};
    }
  };
  let handler:ManagementHandler;
  const server=createServer((req,res)=>void handler(req,res));
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  const address=server.address();
  assert.ok(address && typeof address==='object');
  const host='127.0.0.1:'+address.port,url='http://'+host;
  handler=managementTransport(operations,'sha256:'+createHash('sha256').update(token).digest('hex'),[host]);
  return {url,rotate:()=>{id=randomUUID();},mutations:()=>mutations,close:()=>new Promise<void>(ok=>{server.close(()=>ok());server.closeAllConnections();})};
}

test('REST and official MCP client share schemas, auth, operations and safe errors',async()=>{
  const api=await fixture();
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const client=new Client({name:'test-owner',version:'1'});
  try {
    const doc=api.url+'/api/v1/openapi.json';
    assert.equal((await fetch(doc)).status,401);
    assert.equal((await fetch(doc,{headers:{...headers,origin:'https://example.org'}})).status,403);
    const openapi=await (await fetch(doc,{headers})).json() as any;
    assert.equal(openapi.paths['/api/v1/operations/configure_topic'].post.requestBody.content['application/json'].schema.properties.serverId.format,'uuid');
    assert.equal((await fetch(api.url+'/api/v1/topics',{headers})).status,200);
    assert.ok(openapi.paths['/api/v1/topics/{repoId}'].patch.parameters.some((p:any)=>p.name==='repoId' && p.in==='path'));
    const mismatch=await fetch(api.url+'/api/v1/topics/8',{method:'PATCH',headers,body:JSON.stringify({repoId:9,serverId:randomUUID()})});
    assert.equal(mismatch.status,400);
    const wrongId=await fetch(api.url+'/api/v1/topics/%38',{method:'PATCH',headers,body:JSON.stringify({serverId:randomUUID()})});
    assert.equal(wrongId.status,409);
    const post=(body:string)=>fetch(api.url+'/api/v1/operations/configure_topic',{method:'POST',headers,body});
    assert.equal((await post('{')).status,400);
    assert.equal((await post('{}')).status,400);
    assert.equal((await post('x'.repeat(300000))).status,413);
    assert.equal((await post(JSON.stringify({serverId:randomUUID(),repoId:7}))).status,409);
    await client.connect(new StreamableHTTPClientTransport(new URL(api.url+'/mcp'),{requestInit:{headers}}));
    const tools=await client.listTools();
    assert.deepEqual(tools.tools.map(t=>t.name),['list_topics','configure_topic']);
    const result=await client.callTool({name:'list_topics',arguments:{}});
    assert.equal((result.structuredContent as any).topics[0].sourceUri,uri);
    const wrong=await client.callTool({name:'configure_topic',arguments:{serverId:randomUUID(),repoId:7}});
    assert.equal(wrong.isError,true);
  } finally {await client.close();await api.close();}
});
test('remote CLI pins server, refuses ambiguous and changed identities before mutations',async()=>{
  const one=await fixture(),two=await fixture();
  const dir=await mkdtemp(join(tmpdir(),'jam-cli-')),config=join(dir,'endpoints.json'),secret=join(dir,'owner.key');
  try{
    await writeFile(secret,token,{mode:0o600});
    await cli(['add','one',one.url,secret],config);
    await cli(['route',uri,'configure_topic'],config);
    assert.equal(one.mutations(),1);
    await cli(['add','two',two.url,secret],config);
    await assert.rejects(cli(['route',uri,'configure_topic'],config),/Ambiguous/);
    await cli(['call','two','configure_topic','{"repoId":7}'],config);
    two.rotate();
    await assert.rejects(cli(['call','two','configure_topic','{"repoId":7}'],config),/identity changed/);
    assert.equal(two.mutations(),1);
  } finally {await Promise.all([one.close(),two.close(),rm(dir,{recursive:true,force:true})]);}
});
