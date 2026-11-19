import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,cp,writeFile,readFile,readdir,realpath,rm,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {secretOperations} from '../dist/src/management-secrets.js';
import {managementTransport} from '../dist/src/management-transport.js';

// All values and endpoints belong to this temporary local fixture, never to a managed live project.
test('REST, MCP and stdin CLI share write/masked-read semantics through the durable host exchange',async t=>{
  const fixture=await realpath(await mkdtemp(join(tmpdir(),'jam-secret-flow-')));
  const root=join(fixture,'host'),exchange=join(fixture,'exchange'),runtime=join(root,'runtime');
  await mkdir(root,{mode:0o700});await mkdir(exchange,{mode:0o700});await mkdir(runtime,{mode:0o700});
  for(const file of ['environment-host.mjs','secret-store.mjs','existing-preview.mjs','management-task-host.mjs','s3-release.mjs','s3-artifact.mjs'])
    await cp(new URL('../scripts/macos/'+file,import.meta.url),join(runtime,file));
  await cp(new URL('../dist/src/environment-wire.js',import.meta.url),join(runtime,'environment-wire.js'));
  await writeFile(join(runtime,'package.json'),'{"type":"module"}');
  await symlink(resolve('node_modules'),join(runtime,'node_modules'));
  const token='b'.repeat(64),serverId=randomUUID(),uri='https://github.com/example/secret-test';
  const tokenPath=join(root,'owner.token');await writeFile(tokenPath,token,{mode:0o600});
  await writeFile(join(root,'catalog.json'),JSON.stringify({serverId,recipes:[{repoId:1,environment:'preview',tier:'development',releases:{}}]}),{mode:0o600});
  const prior=process.env.JAM_DEPLOY_EXCHANGE;process.env.JAM_DEPLOY_EXCHANGE=exchange;
  let host;
  function startHost(){host=spawn(process.execPath,[join(runtime,'environment-host.mjs'),root,exchange,tokenPath],{stdio:['ignore','ignore','pipe']});host.stderr.on('data',chunk=>process.stderr.write(chunk));}
  async function stopHost(){if(host?.exitCode===null&&host?.signalCode===null){const ended=new Promise(resolve=>host.once('exit',resolve));host.kill('SIGTERM');await ended;}}
  startHost();
  const routes=new Map([['topic',{topic:{repoId:1,repository:'example/secret-test',installation:1,cwd:root},state:root}]]);
  const operations=[{name:'list_topics',description:'Test inventory',input:z.strictObject({}),output:z.object({serverId:z.uuid(),topics:z.array(z.object({repoId:z.number(),sourceUri:z.string()}))}),mutate:false,
    run:async()=>({serverId,topics:[{repoId:1,sourceUri:uri}]})},...secretOperations(routes,serverId)];
  const api={operations,invoke:async(name,input)=>{const op=operations.find(op=>op.name===name);return op.run(op.input.parse(input));}};
  let handler;
  const server=createServer((req,res)=>void handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();
  const origin='http://127.0.0.1:'+address.port;
  handler=managementTransport(api,token,['127.0.0.1:'+address.port]);
  const client=new Client({name:'secret-canary',version:'1'});
  t.after(async()=>{await client.close().catch(()=>{});await stopHost();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});if(prior===undefined)delete process.env.JAM_DEPLOY_EXCHANGE;else process.env.JAM_DEPLOY_EXCHANGE=prior;await rm(fixture,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const canary='ab-never-in-response-or-journal-yz',requestId=randomUUID();
  const url=origin+'/api/v1/topics/1/environments/preview/secrets/api-key';
  const payload={serverId,value:canary,requestId};
  const sent=await fetch(url,{method:'PUT',headers,body:JSON.stringify(payload)});assert.equal(sent.status,200);
  const receipt=await sent.json();assert.deepEqual(receipt,{requestId,alias:'api-key',updated:true});
  assert.equal(JSON.stringify(receipt).includes(canary),false);
  const get=origin+'/api/v1/topics/1/environments/preview/secrets?serverId='+serverId;
  assert.deepEqual(await fetch(get,{headers}).then(r=>r.json()),{secrets:[{alias:'api-key',present:true,masked:'ab****yz'}]});
  await stopHost();startHost();
  assert.deepEqual(await fetch(url,{method:'PUT',headers,body:JSON.stringify(payload)}).then(r=>r.json()),receipt);
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}));
  const result=await client.callTool({name:'secret_get',arguments:{serverId,repoId:1,environment:'preview',alias:'api-key'}});
  assert.deepEqual(result.structuredContent,{secrets:[{alias:'api-key',present:true,masked:'ab****yz'}]});
  const config=join(fixture,'endpoints.json');
  await writeFile(config,JSON.stringify({endpoints:[{name:'local',url:origin,tokenFile:tokenPath,serverId,topics:[{repoId:1,sourceUri:uri}]}]}),{mode:0o600});
  const cliInput={repoId:1,environment:'preview',alias:'cli-key',value:'xy-stdin-canary-uv',requestId:randomUUID()};
  const output=await new Promise((resolve,reject)=>{
    const child=execFile(process.execPath,['dist/src/management-cli.js','call','local','secret_set','-'],{env:{...process.env,JAM_MANAGEMENT_CONFIG:config},timeout:10000},(error,stdout,stderr)=>error?reject(Error('Secret CLI fixture failed')):resolve(stdout));
    child.stdin.end(JSON.stringify(cliInput));
  });
  assert.equal(output.includes(cliInput.value),false);assert.equal(JSON.parse(output).alias,'cli-key');
  assert.deepEqual((await fetch(get,{headers}).then(r=>r.json())).secrets.map(s=>s.alias),['api-key','cli-key']);
  const denied=await fetch(url,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});assert.equal(denied.status,401);
  const db=new DatabaseSync(join(root,'runner.sqlite'),{readOnly:true});
  const journal=JSON.stringify(db.prepare('SELECT input,response FROM requests').all());db.close();
  assert.equal(journal.includes(canary),false);assert.equal(journal.includes(cliInput.value),false);
  assert.deepEqual(await readdir(join(exchange,'secret-blobs')),[]);
});
