import {fork} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {Client} from '/opt/jam-own/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '/opt/jam-own/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const repository='fixture/jam-review';
const repoId=99;
const assert=(value,message)=>{if(!value)throw Error(message);};

async function serve(token,serverId) {
  const {webhook}=await import('/workspace/dist/src/webhook.js');
  const {openTopic,topicKey}=await import('/workspace/dist/src/topics.js');
  const {createManagement}=await import('/workspace/dist/src/management.js');
  const {managementTransport}=await import('/workspace/dist/src/management-transport.js');
  process.env.JAM_SERVER_ID=serverId;
  const state=await mkdtemp('/tmp/jam-own-management-');
  const installation=21;
  const route=await openTopic(state,{repository,repoId,installation,cwd:join(state,'leo')});
  const routes=new Map([[topicKey(installation,repoId),route]]);
  const api=await createManagement(state,routes,undefined,async()=>{throw Error('No fixture repository mutation');});
  let handler;
  const http=webhook(routes,randomBytes(32).toString('hex'),async()=>false,undefined,(req,res)=>handler(req,res));
  http.listen(0,'127.0.0.1');
  await once(http,'listening');
  const port=http.address().port;
  handler=managementTransport(api,token,['127.0.0.1:'+port]);
  process.once('message',async()=>{
    http.close();
    http.closeAllConnections();
    await api.settle();
    route.journal.db.close();
    await rm(state,{recursive:true,force:true});
    process.disconnect();
  });
  process.send({port});
}

async function verify() {
  const input=JSON.parse(await readFile('/gate/input.json','utf8'));
  const token=randomBytes(48).toString('hex'), serverId=randomUUID();
  const child=fork(fileURLToPath(import.meta.url),['serve',token,serverId],{stdio:['ignore','ignore','ignore','ipc']});
  const shutdown=once(child,'exit');
  const request=AbortSignal.timeout(12000);
  let client;
  try {
    const [{port}]=await Promise.race([once(child,'message',{signal:request}),shutdown.then(()=>{throw Error('Fixture server exited during startup');})]);
    assert(Number.isSafeInteger(port)&&port>0&&port<=65535,'Fixture port was not established');
    const base='http://127.0.0.1:'+port;
    const headers={authorization:'Bearer '+token};
    const get=(path,auth)=>fetch(base+path,{headers:auth,signal:request});
    assert((await get('/health')).status===200,'Health request failed');
    assert((await get('/api/v1/openapi.json')).status===401,'Anonymous REST access was not rejected');
    const openapi=await get('/api/v1/openapi.json',headers);
    assert(openapi.ok&&typeof (await openapi.json()).openapi==='string','Authenticated OpenAPI failed');
    const inventory=await get('/api/v1/topics',headers);
    const verifyInventory=data=>{
      assert(data?.serverId===serverId && data.topics?.length===1 && data.topics[0].repoId===repoId &&
        data.topics[0].repository===repository,'Fixture topic or server identity mismatch');
    };
    assert(inventory.ok,'Authenticated REST inventory failed');
    verifyInventory(await inventory.json());
    client=new Client({name:'jam-own-review',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers}}),{timeout:8000});
    const result=await client.callTool({name:'list_topics',arguments:{}},undefined,{timeout:8000});
    assert(!result.isError,'Authenticated MCP inventory failed');
    verifyInventory(result.structuredContent);
    console.log('Management smoke: '+JSON.stringify({revision:input.sha,passing:true,
      checks:['health','anonymous-rest-denied','authenticated-openapi','authenticated-rest-topics','authenticated-mcp-topics']}));
  } catch (error) {
    console.log('Management smoke: '+JSON.stringify({revision:input.sha,passing:false,message:error.message}));
    process.exitCode=1;
  } finally {
    if(client) await client.close();
    if(child.connected) child.send('close');
    await Promise.race([shutdown,delay(1000).then(()=>child.kill())]);
  }
}

if (process.argv[2]==='serve') await serve(process.argv[3],process.argv[4]);
else await verify();
