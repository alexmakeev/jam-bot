// Instrumentation for the Ubuntu image's pinned Claude Code 2.1.325 Agent Teams protocol.
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

interface Block {
  type: string; text?:string; id?: string; name?: string; tool_use_id?: string;
  input?: {name?: string; subagent_type?: string; to?: string; message?: string; prompt?: string};
  is_error?:boolean; content?: string | {text?: string}[];
}
interface Row { sessionId?: string; cwd?:string; agentId?:string; type:string; message?: {content?: string | Block[];stop_reason?:string} }
interface Roster { leadSessionId:string; members:{name:string;agentId:string;cwd:string;backendType:string}[] }

async function optionalText(path: string): Promise<string> {
  try { return await readFile(path,'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function rows(path: string): Promise<Row[]> {
  const text=await optionalText(path);
  const lines=text.split('\n');
  const tail=lines.pop();
  const parsed:Row[]=lines.filter(Boolean).map(line=>JSON.parse(line));
  // A completed harness row need not have a trailing newline. Ignore only a
  // genuinely partial final JSON object while the writer is appending it.
  if(tail){try{parsed.push(JSON.parse(tail));}catch{}}
  return parsed;
}

// The pinned harness leaves its interactive process open after a terminal model refusal.
export async function stageRefused(log:string,session:string,startedAt:number) {
  const file=await open(log,'r').catch((err:NodeJS.ErrnoException)=>{
    if(err.code!=='ENOENT')throw err;
    return undefined;
  });
  if(!file)return false;
  try{
    const {size}=await file.stat();
    const start=Math.max(0,size-65536),buffer=Buffer.alloc(size-start);
    const {bytesRead}=await file.read(buffer,0,buffer.length,start);
    const lines=buffer.subarray(0,bytesRead).toString('utf8').split('\n');
    if(start)lines.shift();
    lines.pop();
    return lines.some(line=>{
      if(!line.includes('"isApiErrorMessage":true'))return false;
      const row=JSON.parse(line);
      return row.sessionId===session && row.type==='assistant' && row.isApiErrorMessage===true &&
        row.message?.stop_reason==='refusal' && Date.parse(row.timestamp)>=startedAt;
    });
  }finally{await file.close();}
}

export interface TeammateJob {
  state: string; cwd: string; session: string; name: string; agentType: string; challenge: string;
  system: string; prompt: string; expected?: string; signal: AbortSignal;
}

interface ReceiptQuery {
  config: string; cwd: string; session: string; name: string; agentType: string; challenge: string; expected?: string
}

export async function mailboxReceipt({config,cwd,session,name,agentType,challenge,expected}: ReceiptQuery) {
  const team='session-'+session.slice(0,8);
  const raw=await optionalText(join(config,'teams',team,'config.json'));
  if(raw){
    let roster:Roster;
    try{roster=JSON.parse(raw);}catch{return;}
    const member=roster.members?.find(m=>m.name===name && m.backendType==='in-process' && m.cwd===cwd);
    if(roster.leadSessionId!==session || member?.agentId!==name+'@'+team)return;
  }

  const prefix=join(config,'projects',cwd.replace(/[^a-zA-Z0-9-]/g,'-'),session);
  const leadRows=(await rows(prefix+'.jsonl')).filter(r=>r.sessionId===session);
  const blocks=leadRows.flatMap(row=>Array.isArray(row.message?.content)?row.message.content:[]);
  const spawns=blocks.filter(b=>b.type==='tool_use' && b.name==='Agent' && b.input?.name===name &&
    b.input?.subagent_type===agentType && b.input?.prompt?.includes(challenge));
  const callIds=new Set(spawns.map(b=>b.id).filter(Boolean));
  if (callIds.size!==1) return;
  const result=blocks.find(b=>b.type==='tool_result' && callIds.has(b.tool_use_id));
  if(result?.is_error)throw Error('Native teammate spawn was declined or interrupted by the harness; reconcile before another execution');
  const summary=typeof result?.content==='string'?result.content:result?.content?.map(c=>c.text).join('\n');
  const handle=summary?.match(/^agent_id: ([\w-]+)$/m)?.[1];
  if (!handle) return;

  const workerRows=await rows(join(prefix,'subagents','agent-'+handle+'.jsonl'));
  if(!raw){
    // Closing the native team retires its roster. The per-member harness metadata survives.
    const archived=await optionalText(join(prefix,'subagents','agent-'+handle+'.meta.json'));
    if(!archived)return;
    let meta;
    try{meta=JSON.parse(archived);}catch{return;}
    if(meta.name!==name || meta.teamName!==team || meta.taskKind!=='in_process_teammate' ||
        meta.customAgentType!==agentType || meta.spawnedAgentType!==agentType ||
        !workerRows.some(row=>row.agentId===handle && row.sessionId===session && row.cwd===cwd))return;
  }
  const messages=new Set<string>();
  const finalOutputs=new Set<string>();
  const valid=(value:unknown):value is string=>typeof value==='string' && value.length<=65536 &&
    (expected!==undefined?value.trim()===expected:value.trimStart().startsWith(challenge+'\n'));
  for(const row of workerRows){
    if(row.type!=='assistant' || !Array.isArray(row.message?.content))continue;
    for(const block of row.message.content){
      if(block.type==='tool_use' && block.name==='SendMessage' && ['main','team-lead'].includes(block.input?.to??'') &&
          valid(block.input?.message))messages.add(block.input.message);
      if(block.type==='text' && row.message.stop_reason==='end_turn' && valid(block.text))finalOutputs.add(block.text);
    }
  }
  const delivered=new Set<string>();
  for(const row of leadRows){
    const body=row.message?.content;
    if(row.type!=='user' || typeof body!=='string' || !body.startsWith('Another Claude session sent a message:\n'))continue;
    for(const answer of messages)if([answer,answer.trim()].some(text=>
      body.includes('<agent-message from="'+name+'">\n'+text+'\n</agent-message>') ||
      (body.includes('<teammate-message teammate_id="'+name+'"') && body.includes('>\n'+text+'\n</teammate-message>'))))delivered.add(answer);
    const envelope=/^Another Claude session sent a message:\n<teammate-message teammate_id="([^"]+)"[^>]*>\n([^\n]*)\n<\/teammate-message>(?:\n|$)/.exec(body);
    if(!envelope || envelope[1]!==name)continue;
    let notice;
    try{notice=JSON.parse(envelope[2]!);}catch{continue;}
    if(notice?.type!=='idle_notification' || notice.from!==name || notice.idleReason!=='available' || !valid(notice.result))continue;
    // The harness retains the complete turn locally, but abbreviates its automatic mailbox preview.
    for(const full of finalOutputs){
      const preview=full.length>4000?full.slice(0,4000)+'\n[result truncated — ask the agent for the rest via SendMessage]':full;
      if(notice.result===full || notice.result===preview)delivered.add(full);
    }
  }
  const deliveries=[...delivered];
  if (deliveries.length>1) throw new Error('Ambiguous native teammate output');
  if (deliveries.length===1) return { developer:handle, nativeMember:name+'@'+team, backend:'in-process', team,
    output:expected===undefined ? deliveries[0]!.trimStart().slice(challenge.length+1) : deliveries[0]!.trim() };
}

export async function teammateReceipt(config: string, cwd: string, session: string, name: string, challenge: string, answer: string) {
  return mailboxReceipt({config,cwd,session,name,challenge,agentType:'jam-developer',expected:answer});
}

const sessionRuns=new Map<string,Promise<void>>();
export async function runNativeJob(job:TeammateJob){
  const key=job.cwd+'\0'+job.session;
  const previous=sessionRuns.get(key)??Promise.resolve();
  let release!:()=>void;
  const current=new Promise<void>(resolve=>{release=resolve;});
  sessionRuns.set(key,current);
  try{
    await previous;
    job.signal.throwIfAborted();
    return await executeNativeJob(job);
  }finally{
    release();
    if(sessionRuns.get(key)===current)sessionRuns.delete(key);
  }
}

async function executeNativeJob({state,cwd,session,name,agentType,challenge,system,prompt,expected,signal}: TeammateJob) {
  const config=await realpath(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(),'.claude'));
  const home=join(state,'worker-runtime-home');
  await mkdir(home,{recursive:true,mode:0o700});
  try { await symlink(config,join(home,'.claude')); } catch (err) {
    if ((err as NodeJS.ErrnoException).code!=='EEXIST' || await realpath(join(home,'.claude'))!==config) throw err;
  }
  // Isolate CLI onboarding/trust from the user's home. Only the service-owned, fixed cwd is trusted.
  try {
    await writeFile(join(home,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,theme:'dark',numStartups:2,
      projects:{[cwd]:{hasTrustDialogAccepted:true}}}),{flag:'wx',mode:0o600});
  } catch (err) { if ((err as NodeJS.ErrnoException).code!=='EEXIST') throw err; }
  const agents = {[agentType]:{description:'JAM-Bot '+agentType+' teammate',prompt:system,tools:['SendMessage']}};
  const args=['--resume',session,'--setting-sources','','--settings','{"disableAllHooks":true}','--teammate-mode','in-process',
    '--strict-mcp-config','--tools','Agent,SendMessage','--allowedTools','Agent,SendMessage','--agents',JSON.stringify(agents),
    '--permission-mode','dontAsk','--disable-slash-commands','--system-prompt','You are JAM, a native in-process team lead. Forward the stage input to the named native teammate. Wait for its result.',prompt];
  // script supplies a PTY. Print mode falls back to a different, short-lived subagent.
  // All arguments are POSIX-quoted. Issue text is excluded from the command.
  const shellCommand='exec claude '+args.map(arg=>"'"+arg.replaceAll("'","'\\''")+"'").join(' ');
  const startedAt=Date.now();
  const transcript=join(config,'projects',cwd.replace(/[^a-zA-Z0-9-]/g,'-'),session+'.jsonl');
  let nextStatusCheck=startedAt;
  const diagnostics=join(state,'native-diagnostics');
  await mkdir(diagnostics,{recursive:true,mode:0o700});
  const terminal=join(diagnostics,name+'.log');
  const child=spawn('script',['-qefc',shellCommand,terminal],{cwd,stdio:['pipe','ignore','ignore'],
    env:{...process.env,HOME:home,TERM:'xterm-256color',CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:'1'}});
  let error=false;
  child.on('error',()=>{error=true;});
  const closed=new Promise<void>(done=>child.once('close',()=>done()));
  try {
    // A UI implementation or a substantial synthesis can exceed the short checksum probe.
    const timeout=Number(process.env.JAM_NATIVE_STAGE_TIMEOUT_MINUTES??15);
    if(!Number.isInteger(timeout) || timeout<1 || timeout>60)throw Error('Invalid native stage timeout');
    const deadline=Date.now()+timeout*60_000;
    while (Date.now()<deadline) {
      if (signal.aborted) throw new Error('Native teammate interrupted');
      if (error || child.exitCode!==null || child.signalCode!==null) throw new Error('Native teammate runtime exited before verified receipt');
      const receipt=await mailboxReceipt({config,cwd,session,name,challenge,expected,agentType});
      if (receipt) return receipt;
      if(Date.now()>=nextStatusCheck){
        nextStatusCheck=Date.now()+3000;
        if(await stageRefused(transcript,session,startedAt))throw Error('Native model refused this stage; preserve the candidate and reconcile before further work');
      }
      await delay(400);
    }
    throw new Error('Native teammate receipt timed out');
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

export async function runTeammate(state: string, cwd: string, session: string, issue: number, digits: number[], challenge: string, expected: string, signal: AbortSignal) {
  const name='developer-'+issue+'-'+challenge.slice(0,6);
  const prompt='Use Agent exactly once, set name='+name+' and subagent_type=jam-developer. Have this named teammate compute the sum of '+
    digits.join(', ')+'. Give it the challenge '+challenge+'. It must SendMessage to main with the exact single line '+challenge+
    ':<sum>, replacing <sum> with its decimal answer. Wait for the native mailbox result.';
  const {output,...receipt}=await runNativeJob({state,cwd,session,name,agentType:'jam-developer',challenge,expected,signal,prompt,
    system:'Compute the requested sum and send the exact requested line to main using SendMessage. Then wait.'});
  return receipt;
}
