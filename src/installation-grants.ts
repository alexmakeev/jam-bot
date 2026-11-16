import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {availableProjects,GitHubRequestError} from './github-app.js';
import {ManagementError} from './management-contract.js';
import {repositoryName,projectConnector} from './management-projects.js';
import type {TopicRuntime} from './topics.js';

const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const repository=z.object({id,full_name:repositoryName});
const installer=z.object({id,app_id:id,repository_selection:z.enum(['all','selected']).optional(),account:z.object({id,login:z.string().regex(/^[a-z0-9-]+$/i)})});
const payload=z.object({installation:installer,repositories:z.array(repository).optional(),repositories_added:z.array(repository).optional(),
  repositories_removed:z.array(repository).optional(),action:z.string(),repository_selection:z.enum(['all','selected']).optional()});
type Job={delivery:string;installation:number;account:number;login:string;repo:number;name:string;page:number;attempts:number};

export class InstallationGrants {
  readonly db:DatabaseSync;
  private readonly owners=new Map<number,string>();
  constructor(state:string,private readonly routes:ReadonlyMap<string,TopicRuntime>,private readonly connect:ReturnType<typeof projectConnector>,
    private readonly env:NodeJS.ProcessEnv=process.env,private readonly discover=availableProjects){
    for(const {topic} of routes.values())this.owners.set(topic.installation,topic.repository.split('/')[0]!.toLowerCase());
    this.db=new DatabaseSync(join(state,'management.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS installation_grants(delivery TEXT,installation INTEGER,account INTEGER,login TEXT,repo INTEGER,name TEXT,
      page INTEGER NOT NULL DEFAULT 1,attempts INTEGER NOT NULL DEFAULT 0,available INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY(delivery,repo)); CREATE INDEX IF NOT EXISTS grants_pending ON installation_grants(state,available);`);
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_locations'").get())
      for(const row of this.db.prepare('SELECT installation,repository FROM project_locations').all())
        this.owners.set(Number(row.installation),String(row.repository).split('/')[0]!.toLowerCase());
  }
  private bound(installation:number,account:number,login:string){
    const known=this.owners.get(installation)===login.toLowerCase() || [...this.routes.values()].some(({topic})=>topic.installation===installation &&
      topic.repository.split('/')[0]!.toLowerCase()===login.toLowerCase());
    return known || String(installation)===this.env.JAM_INSTALLATION_ID ||
      (this.env.JAM_AUTO_CONNECT_ACCOUNT_IDS??'').split(',').map(v=>v.trim()).includes(String(account));
  }
  accept(type:string,delivery:unknown,data:unknown){
    const parsed=payload.safeParse(data);
    if(!z.uuid().safeParse(delivery).success||!parsed.success)return 400;
    const event=parsed.data,{id:installation,account,app_id}=event.installation;
    if(String(app_id)!==this.env.JAM_GITHUB_APP_ID || !this.bound(installation,account.id,account.login))return 403;
    const all=(event.repository_selection??event.installation.repository_selection)==='all';
    const removed=event.action==='removed'||event.action==='deleted';
    const repos=type==='installation'?(removed?[...this.routes.values()].filter(r=>r.topic.installation===installation).map(({topic})=>({id:topic.repoId,full_name:topic.repository})):event.repositories):
      (removed?event.repositories_removed:event.repositories_added);
    if(repos?.some(r=>r.full_name.split('/')[0]!.toLowerCase()!==account.login.toLowerCase()))return 403;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const put=this.db.prepare('INSERT OR IGNORE INTO installation_grants(delivery,installation,account,login,repo,name) VALUES(?,?,?,?,?,?)');
      for(const repo of repos??[])put.run(String(delivery),installation,account.id,account.login,repo.id,repo.full_name);
      if(!removed && (!repos || (type==='installation' && (all || !repos.length)) ||
         (all && !repos.length)))put.run(String(delivery),installation,account.id,account.login,0,'');
      this.db.exec('COMMIT');return 202;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // A single receiver owns this database; unfinished rows stay pending across a process restart.
  async next(){
    const job=this.db.prepare("SELECT * FROM installation_grants WHERE state='pending' AND available<=unixepoch() ORDER BY available,rowid LIMIT 1").get() as unknown as Job|undefined;
    if(!job)return false;
    const key=[job.delivery,job.repo] as const;
    try{
      if(!this.bound(job.installation,job.account,job.login))throw new ManagementError(409,'binding_changed','Installation is no longer bound here');
      if(job.repo===0){
        const page=await this.discover(job.installation,job.page);
        const rows=z.array(z.object({repoId:id,sourceUri:z.string()})).parse(page.projects);
        this.db.exec('BEGIN IMMEDIATE');
        try{
          for(const r of rows){
            const full=repositoryName.parse(new URL(r.sourceUri).pathname.slice(1));
            if(r.sourceUri!=='https://github.com/'+full || full.split('/')[0]!.toLowerCase()!==job.login.toLowerCase())throw Error('Installation inventory owner mismatch');
            this.db.prepare('INSERT OR IGNORE INTO installation_grants(delivery,installation,account,login,repo,name) VALUES(?,?,?,?,?,?)')
              .run(job.delivery,job.installation,job.account,job.login,r.repoId,full);
          }
          this.db.prepare('UPDATE installation_grants SET page=page+1,state=? WHERE delivery=? AND repo=?').run(rows.length===100?'pending':'done',...key);
          this.db.exec('COMMIT');
        }catch(e){this.db.exec('ROLLBACK');throw e;}
      }else{
        const absent=async()=>{
          for(let page=1;;page++){
            let inventory;
            try{inventory=await this.discover(job.installation,page);}
            catch(error){if(error instanceof GitHubRequestError && error.status===404)return true;throw error;}
            if(inventory.projects.some((r:{repoId:number})=>r.repoId===job.repo))return false;
            if(inventory.projects.length<100)return true;
          }
        };
        let active=true;
        try{await this.connect('https://github.com/'+job.name,job.installation,{repoId:job.repo,accountId:job.account});}
        catch(error){
          if(!(error instanceof ManagementError) || error.code!=='installation_unavailable')throw error;
          if(!await absent())throw error;
          active=false;
          await this.connect.revoke(job.installation,job.repo,absent);
        }
        this.db.prepare("UPDATE installation_grants SET state='done' WHERE delivery=? AND repo=?").run(...key);
        console.log('Verified GitHub installation grant',job.delivery,job.name,job.repo,active?'active':'absent');
      }
    }catch(e){
      const conflict=e instanceof ManagementError && e.status===409;
      this.db.prepare('UPDATE installation_grants SET state=?,attempts=attempts+1,available=unixepoch()+? WHERE delivery=? AND repo=?')
        .run(conflict?'conflict':'pending',Math.min(1800,5*2**Math.min(job.attempts,9)),...key);
      console.error('GitHub installation registration',conflict?'identity conflict':'retry scheduled',job.delivery,job.repo);
    }
    return true;
  }
  async run(signal:AbortSignal){
    while(!signal.aborted){if(!await this.next())await delay(500,undefined,{signal}).catch(()=>{});}
  }
}
