// This host-only process owns Docker access and reads the operator's private recipe catalog.
import {execFile} from 'node:child_process';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod,lstat,mkdir,open,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {connect,createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {signEnvironment,validEnvironmentSignature,selectEnvironmentRecipe} from './environment-wire.js';

const exec=promisify(execFile);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const alias=/^[a-z][a-z0-9-]{0,39}$/;
const revision=/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const image=/^sha256:[0-9a-f]{64}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
function allowedKeys(obj,keys){return obj && typeof obj==='object' && !Array.isArray(obj) && Object.keys(obj).every(k=>keys.includes(k));}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const validPort=n=>Number.isInteger(n)&&n>=1024&&n<=65535;
function validate(input,host,recipe){
  if(!allowedKeys(input,['id','at','serverId','repoId','environment','action','revision','tier','config','secretRefs','appVariables','endpoint'])||
    !uuid.test(input.id)||!Number.isSafeInteger(input.at)||input.serverId!==host.serverId||!Number.isSafeInteger(input.repoId)||input.repoId<1||
    typeof input.environment!=='string'||!alias.test(input.environment)||!['deploy','status','stop'].includes(input.action))throw Error('Invalid request or destination');
  if(!recipe||input.tier!==recipe.tier)throw Error('Environment or tier is outside host recipes');
  if(input.action!=='deploy'){if(input.revision!==undefined)throw Error('Only deploy accepts a revision');return;}
  if(!revision.test(input.revision)||!Object.hasOwn(recipe.releases,input.revision)||!image.test(recipe.releases[input.revision]))throw Error('Release is not registered on this host');
  if(recipe.tier==='stable'&&!recipe.stableApprovedRevisions?.includes(input.revision))throw Error('Exact stable release lacks host approval');
  if(!allowedKeys(input.config??{},['LOG_LEVEL'])||!['debug','info','warn','error'].includes(input.config?.LOG_LEVEL??'info'))throw Error('Unsupported log level');
  const refs=input.secretRefs??[];
  if(!Array.isArray(refs)||refs.length>16||new Set(refs).size!==refs.length||refs.some(n=>typeof n!=='string'||!alias.test(n)||!Object.hasOwn(recipe.secrets??{},n)))throw Error('Unknown secret binding');
  const vars=input.appVariables??{};
  if(!allowedKeys(vars,recipe.appVariables??[])||Object.entries(vars).some(([k,v])=>!/^APP_[A-Z0-9_]{1,60}$/.test(k)||typeof v!=='string'||!/^[a-zA-Z0-9_ .:/,+-]{0,256}$/.test(v)))throw Error('Unsupported application variable');
  if(input.endpoint && (!allowedKeys(input.endpoint,['port','address'])||input.endpoint.address!=='127.0.0.1'||!validPort(input.endpoint.port)||
    recipe.allowBridgeEgress!==true||!validPort(recipe.containerPort)||!recipe.loopbackPorts?.includes(input.endpoint.port)))throw Error('Endpoint is outside host recipe');
}
export function composeModel(project,owner,recipe,target,generation){
  const labels={'io.jam-bot.owner':owner,'io.jam-bot.generation':generation};
  const endpoint=target.endpoint;
  const service={image:recipe.releases[target.revision],pull_policy:'never',restart:'unless-stopped',user:'65532:65532',
    read_only:true,init:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],pids_limit:80,mem_limit:'256m',cpus:0.5,
    tmpfs:['/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700'],
    environment:{LOG_LEVEL:target.config?.LOG_LEVEL??'info',...target.appVariables},labels};
  const model={name:project,services:{app:service}};
  if(endpoint){
    service.ports=[{host_ip:'127.0.0.1',published:String(endpoint.port),target:recipe.containerPort,protocol:'tcp'}];
    service.networks=['published'];
    model.networks={published:{driver:'bridge',labels:{'io.jam-bot.owner':owner}}};
  }else service.network_mode='none';
  if(recipe.dataPath){
    if(!/^\/data(?:\/[a-z][a-z0-9-]{0,39})?$/.test(recipe.dataPath))throw Error('Unsupported data volume mount');
    model.volumes={data:{name:project+'_data',labels:{'io.jam-bot.owner':owner}}};
    service.volumes=[{type:'volume',source:'data',target:recipe.dataPath}];
  }
  const refs=target.secretRefs??[];
  if(refs.length){
    model.secrets=Object.fromEntries(refs.map(k=>[k,{file:recipe.secrets[k]}]));
    service.secrets=refs.map(k=>({source:k,target:k}));
  }
  return model;
}
const cliEnv=Object.fromEntries(['HOME','PATH','TMPDIR','DOCKER_CONFIG','DOCKER_HOST','DOCKER_CONTEXT'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
async function docker(args){try{return (await exec('docker',args,{env:cliEnv,timeout:65000,maxBuffer:512*1024})).stdout.trim();}
  catch{throw Error('Docker operation failed: '+args.slice(0,2).join(' '));}}
async function privateFile(file,max=262144){
  const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=await fd.stat();if(!s.isFile()||s.nlink!==1||s.size>max)throw Error('Invalid broker file');return await fd.readFile('utf8');}
  finally{await fd.close();}
}
async function privateConfig(file){const st=await lstat(file);if(!st.isFile()||st.uid!==process.getuid()||(st.mode&0o077))throw Error('Host configuration permissions must be 0600');return privateFile(file);}
export async function serve(root,exchange,tokenPath) {
  const meta=await lstat(root);if(!meta.isDirectory()||meta.uid!==process.getuid()||(meta.mode&0o077))throw Error('Host catalog directory must be private');
  const token=(await privateConfig(tokenPath)).trim();if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid operator credential');
  const host=JSON.parse(await privateConfig(join(root,'catalog.json')));
  if(!uuid.test(host.serverId)||!Array.isArray(host.recipes))throw Error('Invalid host catalog');
  const db=new DatabaseSync(join(root,'runner.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'deploy',response TEXT);
    CREATE TABLE IF NOT EXISTS environments(k TEXT PRIMARY KEY,owner TEXT NOT NULL,lastGood TEXT,container TEXT,pending TEXT);`);
  const inspect=async id=>JSON.parse(await docker(['inspect',id]))[0];
  async function run(x){
    const key=x.serverId+'/'+x.repoId+'/'+x.environment;
    let recipe=selectEnvironmentRecipe(host.recipes,x.repoId,x.environment);
    if(x.action==='deploy' && x.repoId===1457276291 && x.environment==='calculator' && recipe?.tier==='development' && recipe.autoDeployCalculator===true){
      let releases={};
      try{releases=JSON.parse(await privateConfig(join(root,'calculator-dev-releases.json')));}
      catch(error){if(error.code!=='ENOENT')throw error;}
      if(Object.entries(releases).some(([sha,id])=>!/^[a-f0-9]{40}$/.test(sha)||!image.test(id)))throw Error('Invalid development release index');
      if(Object.hasOwn(releases,x.revision) && ((x.secretRefs?.length??0)>0 || x.endpoint?.port!==19853 || x.endpoint?.address!=='127.0.0.1'))
        throw Error('Automatic calculator releases require the dedicated loopback endpoint and no secrets');
      recipe={...recipe,releases:{...releases,...recipe.releases}};
    }
    validate(x,host,recipe);
    const project='jamenv-'+digest(key).slice(0,24);
    db.prepare('INSERT OR IGNORE INTO environments(k,owner) VALUES(?,?)').run(key,randomUUID());
    let row=db.prepare('SELECT * FROM environments WHERE k=?').get(key);
    const previous=row.lastGood?JSON.parse(row.lastGood):null;
    async function current(){
      const volume=project+'_data';
      const present=await docker(['volume','ls','--filter','name=^'+volume+'$','--format','{{.Name}}']);
      if(present){const v=JSON.parse(await docker(['volume','inspect',volume]))[0];if(v.Name!==volume||v.Driver!=='local'||Object.keys(v.Options??{}).length||v.Labels?.['io.jam-bot.owner']!==row.owner)throw Error('Persistent volume ownership needs reconciliation');}
      const stdout=await docker(['ps','-a','--filter','label=com.docker.compose.project='+project,'--format','{{.ID}}']);
      const ids=stdout.split('\n').filter(Boolean);if(ids.length>1)throw Error('Unexpected additional project containers');
      const networks=(await docker(['network','ls','--filter','label=com.docker.compose.project='+project,'-q'])).split('\n').filter(Boolean);
      for(const id of networks){const net=JSON.parse(await docker(['network','inspect',id]))[0];if(net.Labels?.['io.jam-bot.owner']!==row.owner)throw Error('Unexpected project network ownership');}
      if(!ids.length)return null;
      const c=await inspect(ids[0]);const labels=c.Config.Labels??{};
      if(labels['io.jam-bot.owner']!==row.owner||labels['com.docker.compose.service']!=='app'||
        (c.Id!==row.container && labels['io.jam-bot.generation']!==row.pending))throw Error('Host container ownership needs reconciliation');
      return c;
    }
    function result(c,good){const port=Object.values(c?.NetworkSettings?.Ports??{}).flat().find(v=>v&&v.HostIp==='127.0.0.1');
      const healthy=Boolean(c?.State?.Running && c.State.Health?.Status==='healthy');
      return {environment:x.environment,running:Boolean(c?.State?.Running),healthy,revision:c&&good?.image===c.Image?good.revision:null,
        image:c?.Image??null,endpoint:port?{address:port.HostIp,port:Number(port.HostPort)}:null};}
    const existing=await current();
    if(x.action==='status')return result(existing,previous);
    if(x.action==='stop'){
      if(existing?.State?.Running)await docker(['stop','--time','8',existing.Id]);
      return result(await current(),previous);
    }
    const directory=join(root,project+'-secrets');
    const secretRefs=[...(x.secretRefs??[])].sort(),secretVersions={};
    if(secretRefs.length)await mkdir(directory,{recursive:true,mode:0o700});
    for(const ref of secretRefs){
      const source=recipe.secrets[ref];
      if(typeof source!=='string'||resolve(source)!==source)throw Error('Invalid registered secret file');
      const fd=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const st=await fd.stat();if(!st.isFile()||st.nlink!==1||st.size>65536)throw Error('Invalid secret source');
        const bytes=await fd.readFile(),version=createHmac('sha256',token).update('jam-secret-version\0').update(bytes).digest('hex');
        const snapshot=join(directory,version);secretVersions[ref]=version;
        if(!await lstat(snapshot).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;})){
          const temporary=snapshot+'.'+randomUUID()+'.tmp';
          try{await writeFile(temporary,bytes,{mode:0o400,flag:'wx'});await chmod(temporary,0o444);await rename(temporary,snapshot);}
          finally{await rm(temporary,{force:true});}
        }
      }finally{await fd.close();}
    }
    const target={revision:x.revision,config:{LOG_LEVEL:x.config?.LOG_LEVEL??'info'},secretRefs,secretVersions,
      appVariables:Object.fromEntries(Object.entries(x.appVariables??{}).sort()),endpoint:x.endpoint?{address:'127.0.0.1',port:x.endpoint.port}:null,dataPath:recipe.dataPath??null,image:recipe.releases[x.revision]};
    if(same(target,previous) && result(existing,previous).healthy && same(result(existing,previous).endpoint,target.endpoint))return result(existing,previous);
    if(target.endpoint){
      const port=target.endpoint.port;
      const assigned=db.prepare('SELECT lastGood FROM environments WHERE k<>? AND lastGood IS NOT NULL').all(key);
      if(assigned.some(other=>JSON.parse(other.lastGood).endpoint?.port===port))throw Error('Port already reserved by another environment');
      if(result(existing,previous).endpoint?.port!==port)await new Promise((ok,fail)=>{
        const probe=createServer();probe.once('error',()=>fail(Error('Requested loopback port already occupied')));probe.listen(port,'127.0.0.1',()=>probe.close(ok));});
    }
    const spec=join(root,project+'.json');
    async function deploy(want,gen){
      if(!image.test(want.image)||recipe.releases[want.revision]!==want.image)throw Error('Last known release unavailable');
      if(recipe.tier==='stable'&&!recipe.stableApprovedRevisions?.includes(want.revision))throw Error('Stable release is no longer host-approved');
      const im=JSON.parse(await docker(['image','inspect',want.image]))[0];
      if(im.Id!==want.image||!im.Config.Healthcheck?.Test||im.Config.Healthcheck.Test[0]==='NONE'||Object.keys(im.Config.Volumes??{}).length)throw Error('Image must be preinstalled with healthcheck and without declared volumes');
      const secrets={};
      for(const ref of want.secretRefs){
        if(!Object.hasOwn(recipe.secrets??{},ref))throw Error('Secret binding was revoked');
        const version=want.secretVersions?.[ref];
        if(version!==undefined && !/^[0-9a-f]{64}$/.test(version))throw Error('Invalid recorded secret version');
        // Older persisted deployments used an operator-owned snapshot named after the alias.
        const path=join(directory,version??ref);
        if(!(await lstat(path)).isFile())throw Error('Secret snapshot unavailable');
        secrets[ref]=path;
      }
      const model=composeModel(project,row.owner,{...recipe,secrets},want,gen);
      await writeFile(spec,JSON.stringify(model),{mode:0o600});
      db.prepare('UPDATE environments SET pending=? WHERE k=?').run(gen,key);row.pending=gen;
      await docker(['compose','--project-directory',root,'--project-name',project,'--env-file','/dev/null','-f',spec,'up','-d','--no-build','--pull','never','--wait','--wait-timeout','35']);
      let c=await current();
      if(c?.Image!==want.image||c.Config.Labels['io.jam-bot.generation']!==gen||!result(c,want).healthy)throw Error('Image or readiness mismatch');
      await delay(1200);
      c=await current();if(c?.Image!==want.image||!result(c,want).healthy||!same(result(c,want).endpoint,want.endpoint))throw Error('Health or published endpoint did not remain ready');
      if(want.dataPath&&!c.Mounts.some(m=>m.Type==='volume'&&m.Name===project+'_data'&&m.Destination===want.dataPath&&m.RW))throw Error('Persistent data volume mismatch');
      if(want.endpoint)await new Promise((ok,fail)=>{const socket=connect(want.endpoint.port,'127.0.0.1');socket.setTimeout(2500);socket.once('connect',()=>{socket.destroy();ok();});socket.once('timeout',()=>{socket.destroy();fail(Error('Endpoint timed out'));});socket.once('error',()=>fail(Error('Endpoint unreachable')));});
      db.prepare('UPDATE environments SET lastGood=?,container=?,pending=NULL WHERE k=?').run(JSON.stringify(want),c.Id,key);
      // Rollback still has its original snapshots until the new observed release is durable.
      const retained=new Set(Object.values(want.secretVersions??{}));
      for(const name of await readdir(directory).catch(()=>[])){
        if(/^[a-f0-9]{64}$/.test(name)&&!retained.has(name))await rm(join(directory,name),{force:true}).catch(()=>{});
      }
      return result(c,want);
    }
    try{if(db.prepare('SELECT phase FROM requests WHERE id=?').get(x.id)?.phase==='rollback')throw Error('Resume rollback');return await deploy(target,x.id);}
    catch(reason){
      db.prepare("UPDATE requests SET phase='rollback' WHERE id=?").run(x.id);
      const broken=await current();
      if(broken){db.prepare('UPDATE environments SET container=? WHERE k=?').run(broken.Id,key);row.container=broken.Id;}
      if(previous){try{await deploy(previous,x.id+'-rollback');}catch{throw Error('Release and recovery both failed; inspect host state');}throw Error('Release failed; previous healthy revision restored');}
      if(broken?.State?.Running)await docker(['stop','--time','8',broken.Id]);
      throw Error('Release failed; no prior healthy revision');
    }
  }
  async function send(id,reply){
    const body=JSON.stringify({id,...reply}),out=join(exchange,id+'.response'),tmp=out+'.'+randomUUID()+'.tmp';
    await writeFile(tmp,JSON.stringify({body,signature:signEnvironment(token,'response',body)}),{flag:'wx',mode:0o600});await rename(tmp,out);
  }
  async function finish(row){
    let reply;try{reply={ok:true,value:await run(JSON.parse(row.input))};}catch(e){reply={ok:false,error:String(e.message).slice(0,300)};}
    db.prepare("UPDATE requests SET state='done',response=? WHERE id=?").run(JSON.stringify(reply),row.id);
    await send(row.id,reply);
  }
  // launchd's lockf holds a non-expiring OS lease around this process through every Docker call.
  for(const row of db.prepare("SELECT * FROM requests WHERE state='started' ORDER BY rowid").all())await finish(row);
  while(true){
    for(const name of await readdir(exchange)){
      const id=name.slice(0,-8);if(!name.endsWith('.request')||!uuid.test(id))continue;
      const path=join(exchange,name);
      try{
        const outer=JSON.parse(await privateFile(path,16384));
        if(!allowedKeys(outer,['body','signature'])||typeof outer.body!=='string'||!validEnvironmentSignature(token,'request',outer.body,outer.signature))continue;
        const x=JSON.parse(outer.body);if(x.id!==id||!Number.isSafeInteger(x.at))continue;
        const h=digest(outer.body),prior=db.prepare('SELECT * FROM requests WHERE id=?').get(id);
        if(prior){if(h!==prior.hash)continue;if(prior.state==='done')await send(id,JSON.parse(prior.response));continue;}
        if(Math.abs(Date.now()-x.at)>120000)continue;
        db.prepare("INSERT INTO requests(id,hash,input,state) VALUES(?,?,?,'started')").run(id,h,outer.body);
        await finish({id,input:outer.body});
      }catch{/* Ignore malformed, unauthenticated or incomplete exchange files. Durable intents resume on restart. */}
      finally{await rm(path,{force:true}).catch(()=>{});}
    }
    await delay(200);
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  process.umask(0o077);
  await serve(...process.argv.slice(2));
}
