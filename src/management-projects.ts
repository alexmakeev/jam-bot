import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { profileKinds } from './profile-card.js';
import { openTopic, topicKey, type TopicRuntime } from './topics.js';
import { ManagementError } from './management-contract.js';
import { inspectProject } from './github-app.js';

export const workClass = z.enum(profileKinds);
export const repositoryName = z.string().regex(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/)
  .refine(value=>!['.','..'].includes(value.split('/')[1] ?? ''));
export const sourceUri = z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/)
  .refine(value=>repositoryName.safeParse(value.slice('https://github.com/'.length)).success);

function catalog<T>(state:string,action:(db:DatabaseSync)=>T):T {
  const db=new DatabaseSync(join(state,'management.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS server (singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(repoId INTEGER PRIMARY KEY,repository TEXT NOT NULL COLLATE NOCASE UNIQUE,
        installation INTEGER NOT NULL, defaultClass TEXT);
      CREATE TABLE IF NOT EXISTS defaults(repoId INTEGER PRIMARY KEY,kind TEXT NOT NULL,environment TEXT);`);
    return action(db);
  } finally { db.close(); }
}

export function serverIdentity(state:string):string {
  return catalog(state,db=>{
    const pinned=process.env.JAM_SERVER_ID===undefined ? undefined : z.uuid().parse(process.env.JAM_SERVER_ID);
    db.prepare('INSERT OR IGNORE INTO server VALUES(1,?)').run(pinned??randomUUID());
    const id=z.uuid().parse(db.prepare('SELECT id FROM server WHERE singleton=1').get()?.id);
    if(pinned && pinned!==id)throw new ManagementError(409,'wrong_server','The saved server identity differs from the installed host.');
    return id;
  });
}

export function configureTopic(state:string,route:TopicRuntime,kind:typeof profileKinds[number], environment:string|null) {
  catalog(state,db=>db.prepare('INSERT OR REPLACE INTO defaults(repoId,kind,environment) VALUES(?,?,?)').run(route.topic.repoId,kind,environment));
  route.topic.defaultEnvironment=environment??undefined;
  route.topic.defaultClass=kind;
}

interface Binding {repoId:number;repository:string;installation:number}
async function attach(state:string,routes:Map<string,TopicRuntime>,binding:Binding) {
  const key=topicKey(binding.installation,binding.repoId);
  for (const [existingKey,route] of routes) {
    if(route.topic.repoId!==binding.repoId && route.topic.repository.toLowerCase()!==binding.repository.toLowerCase()) continue;
    if(existingKey!==key || route.topic.repository!==binding.repository)
      throw new ManagementError(409,'topic_conflict','Repository placement changed. Reconcile the registered topic before continuing.');
    return {route,added:false};
  }
  const directory=join(state,'projects',repositoryName.parse(binding.repository));
  const route=await openTopic(directory,{...binding,cwd:join(directory,'leo')});
  routes.set(key,route);
  return {route,added:true};
}

export async function restoreManagedTopics(state:string,routes:Map<string,TopicRuntime>) {
  const {projects,defaults}=catalog(state,db=>({
    projects:db.prepare('SELECT repoId,repository,installation FROM projects').all(),
    defaults:db.prepare('SELECT repoId,kind,environment FROM defaults').all()
  }));
  for(const row of projects)
    await attach(state,routes,{repoId:Number(row.repoId),repository:String(row.repository),installation:Number(row.installation)});
  for(const row of defaults) {
    const route=Array.from(routes.values()).find(r=>r.topic.repoId===row.repoId);
    if(route){
      route.topic.defaultClass=workClass.parse(row.kind);
      route.topic.defaultEnvironment=typeof row.environment==='string' ? row.environment : undefined;
    }
  }
}

export function projectConnector(state:string,routes:Map<string,TopicRuntime>,onAdded:(route:TopicRuntime)=>void,
  inspect=inspectProject) {
  let update=Promise.resolve();
  return async (uri:string,installation:number)=>{
    const requested=sourceUri.parse(uri).slice('https://github.com/'.length);
    let binding:Binding;
    try { binding=await inspect(requested,installation); }
    catch {throw new ManagementError(403,'installation_unavailable','Verify the GitHub App installation and repository Issues write access.');}
    if(binding.repository.toLowerCase()!==requested.toLowerCase() || binding.installation!==installation ||
       !Number.isSafeInteger(binding.repoId) || binding.repoId<1)
      throw new ManagementError(409,'repository_changed','GitHub returned a different repository identity.');
    const connect=update.then(async()=>{
      // Store the desired binding before activating it. Restart replays this operation.
      catalog(state,db=>{
        const old=db.prepare('SELECT * FROM projects WHERE repoId=? OR repository=?').all(binding.repoId,binding.repository);
        if(old.some(r=>r.repoId!==binding.repoId || r.repository!==binding.repository || r.installation!==binding.installation))
          throw new ManagementError(409,'topic_conflict','Stored repository binding conflicts with GitHub.');
        for(const {topic} of routes.values()){
          if(topic.repoId===binding.repoId || topic.repository.toLowerCase()===binding.repository.toLowerCase()){
            if(topic.repoId!==binding.repoId || topic.repository!==binding.repository || topic.installation!==binding.installation)
              throw new ManagementError(409,'topic_conflict','Configured topic conflicts with GitHub.');
            return; // Existing installer-owned topics retain their original state directory.
          }
        }
        db.prepare('INSERT OR IGNORE INTO projects(repoId,repository,installation) VALUES(?,?,?)')
          .run(binding.repoId,binding.repository,binding.installation);
      });
      const {route,added}=await attach(state,routes,binding);
      if(added) onAdded(route);
      return route;
    });
    update=connect.then(()=>{},()=>{});
    return connect;
  };
}
