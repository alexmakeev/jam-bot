import {setTimeout as delay} from 'node:timers/promises';
import {GitHubRequestError,issueClient,publisherAccount} from './github-app.js';
import type {TopicRuntime} from './topics.js';

const title='JAM-Bot is connected';
const login=/^[A-Za-z0-9-]+$/;
type Api=Awaited<ReturnType<typeof issueClient>>;

async function recipient(api:Api,owner:{type:string;login:string}):Promise<string> {
  if(owner.type==='User' && login.test(owner.login))return owner.login;
  // GitHub returns effective repository access, including organization team grants.
  for(const role of ['admin','maintain']){
    for(let page=1;;page++){
      const users=await api('/collaborators?permission='+role+'&per_page=100&page='+page);
      const human=users.find((u:{type:string;login:string})=>u.type==='User' && login.test(u.login));
      if(human)return human.login;
      if(users.length<100)break;
    }
  }
  throw Error('No verified human repository maintainer found');
}

export async function connectionNotice(route:TopicRuntime,signal:AbortSignal,
  apiFactory=issueClient,publisher=publisherAccount):Promise<boolean>{
  const {topic,journal:{db}}=route;
  db.exec(`CREATE TABLE IF NOT EXISTS connection_notice(repo INTEGER PRIMARY KEY, status TEXT NOT NULL, issue INTEGER, url TEXT)`);
  const saved=db.prepare('SELECT status FROM connection_notice WHERE repo=?').get(topic.repoId);
  if(saved?.status==='sent')return true;
  const api=await apiFactory(topic.repository,topic.installation);
  const repo=await api('');
  if(repo.id!==topic.repoId || repo.full_name!==topic.repository || !repo.has_issues)throw Error('Repository issues unavailable');
  const bot=await publisher(topic.repository,topic.installation);
  const marker='<!-- jam-bot:connection:v1:'+topic.repoId+' -->';
  const save=(issue:any)=>{
    if(issue?.pull_request || issue?.user?.type!=='Bot' || issue?.user?.id!==bot.id || !issue.body?.includes(marker) ||
      !Number.isSafeInteger(issue.number)||issue.number<=0 || issue.html_url!=='https://github.com/'+topic.repository+'/issues/'+issue.number)return false;
    db.prepare("INSERT OR REPLACE INTO connection_notice VALUES(?,'sent',?,?)").run(topic.repoId,issue.number,issue.html_url);
    return true;
  };
  for(let page=1;;page++){
    signal.throwIfAborted();
    const issues=await api('/issues?state=all&creator='+encodeURIComponent(bot.login)+'&sort=created&direction=desc&per_page=100&page='+page);
    if(issues.some(save))return true;
    if(issues.length<100)break;
  }
  // A lost POST response can hide a successful write. Recover the marked issue,
  // including a closed issue, before allowing any further publication.
  if(saved?.status==='sending')return false;
  const who=await recipient(api,repo.owner);
  const env=topic.defaultEnvironment;
  const environment=env&&/^[a-z][a-z0-9-]{0,39}$/.test(env)?
    'The configured default environment is `'+env+'`; its health is available through JAM-Bot.':
    'This project has no default deployment environment selected.';
  const body='@'+who+', JAM-Bot is connected and listening for work cards in this repository. To start work, a maintainer with write access can open an issue, describe the desired result and acceptance criteria, and select the **Task** issue type. '+environment+' You may close this notice.\n\n'+marker;
  signal.throwIfAborted();
  if(!db.prepare("INSERT OR IGNORE INTO connection_notice(repo,status) VALUES(?,'sending')").run(topic.repoId).changes)return false;
  try{
    const issue=await api('/issues','POST',{title,body});
    if(!save(issue))throw Error('Cannot attest notification author or issue');
    return true;
  }catch(error){
    // Only an explicit rejection permits a subsequent create. A timeout or 5xx
    // leaves the receipt pending for read-only recovery.
    if(error instanceof GitHubRequestError && [401,403,404,422,429].includes(error.status))
      db.prepare("DELETE FROM connection_notice WHERE repo=? AND status='sending'").run(topic.repoId);
    throw error;
  }
}

export async function deliverConnectionNotice(route:TopicRuntime,signal:AbortSignal){
  let retry=5000;
  while(!signal.aborted){
    try{if(await connectionNotice(route,signal))return;}
    catch{if(!signal.aborted)console.error('Connection notice requires reconciliation for repository',route.topic.repoId);}
    await delay(retry,undefined,{signal}).catch(()=>{});
    retry=Math.min(retry*2,30*60_000);
  }
}
