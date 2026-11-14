// Instrumentation for the Ubuntu image's pinned Claude Code 2.1.325 Agent Teams protocol.
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

interface Block {
  type: string; id?: string; name?: string; tool_use_id?: string;
  input?: {name?: string; subagent_type?: string; to?: string; message?: string; prompt?: string};
  content?: {text?: string}[];
}
interface Row { sessionId?: string; type:string; message?: {content?: string | Block[]} }
interface Roster { leadSessionId:string; members:{name:string;agentId:string;cwd:string;backendType:string}[] }

async function optionalText(path: string): Promise<string> {
  try { return await readFile(path,'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function rows(path: string): Promise<Row[]> {
  const text=await optionalText(path);
  // The final line may still be in flight.
  return text.slice(0,text.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(line=>JSON.parse(line));
}

export async function teammateReceipt(config: string, cwd: string, session: string, name: string, challenge: string, answer: string) {
  const team='session-'+session.slice(0,8);
  const raw=await optionalText(join(config,'teams',team,'config.json'));
  if (!raw) return;
  let roster: Roster;
  try { roster=JSON.parse(raw); } catch { return; }
  const member=roster.members?.find(m=>m.name===name && m.backendType==='in-process' && m.cwd===cwd);
  if (roster.leadSessionId!==session || member?.agentId!==name+'@'+team) return;

  const prefix=join(config,'projects',cwd.replace(/[^a-zA-Z0-9-]/g,'-'),session);
  const leadRows=(await rows(prefix+'.jsonl')).filter(r=>r.sessionId===session);
  const blocks=leadRows.flatMap(row=>Array.isArray(row.message?.content)?row.message.content:[]);
  const spawns=blocks.filter(b=>b.type==='tool_use' && b.name==='Agent' && b.input?.name===name &&
    b.input?.subagent_type==='jam-developer' && b.input?.prompt?.includes(challenge));
  const callIds=new Set(spawns.map(b=>b.id).filter(Boolean));
  if (callIds.size!==1) return;
  const result=blocks.find(b=>b.type==='tool_result' && callIds.has(b.tool_use_id));
  const handle=result?.content?.map(c=>c.text).join('\n').match(/^agent_id: ([\w-]+)$/m)?.[1];
  if (!handle) return;

  const workerRows=await rows(join(prefix,'subagents','agent-'+handle+'.jsonl'));
  const sent=workerRows.some(row=>row.type==='assistant' && Array.isArray(row.message?.content) &&
    row.message.content.some(b=>b.type==='tool_use' && b.name==='SendMessage' &&
      ['main','team-lead'].includes(b.input?.to ?? '') && b.input?.message?.trim()===answer));
  const received=leadRows.some(row=>{
    const body=row.message?.content;
    if (row.type!=='user' || typeof body!=='string' || !body.startsWith('Another Claude session sent a message:\n')) return false;
    return body.includes('<agent-message from="'+name+'">\n'+answer+'\n</agent-message>') ||
      (body.includes('<teammate-message teammate_id="'+name+'"') && body.includes('>\n'+answer+'\n</teammate-message>'));
  });
  if (sent && received) return { developer:handle, nativeMember:member.agentId, backend:member.backendType, team };
}

export async function runTeammate(state: string, cwd: string, session: string, issue: number, digits: number[], challenge: string, expected: string, signal: AbortSignal) {
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
  const name='developer-'+issue+'-'+challenge.slice(0,6);
  const prompt='Use Agent exactly once, set name='+name+' and subagent_type=jam-developer. Have this named teammate compute the sum of '+
    digits.join(', ')+'. Give it the challenge '+challenge+'. It must SendMessage to main with the exact single line '+challenge+
    ':<sum>, replacing <sum> with its decimal answer. Wait for the native mailbox result.';
  const agents={'jam-developer':{description:'Local arithmetic teammate',prompt:'Compute the requested sum and send the exact requested line to main using SendMessage. Then wait.',tools:['SendMessage']}};
  const args=['--resume',session,'--setting-sources','','--settings','{"disableAllHooks":true}','--teammate-mode','in-process',
    '--strict-mcp-config','--tools','Agent,SendMessage','--allowedTools','Agent,SendMessage','--agents',JSON.stringify(agents),
    '--permission-mode','dontAsk','--disable-slash-commands','--system-prompt','You are Leo, a native in-process team lead. Delegate the fixed test to one named teammate.',prompt];
  // script supplies a PTY. Print mode falls back to a different, short-lived subagent.
  // All arguments are POSIX-quoted. Issue text is excluded from the command.
  const shellCommand='exec claude '+args.map(arg=>"'"+arg.replaceAll("'","'\\''")+"'").join(' ');
  const child=spawn('script',['-qefc',shellCommand,'/dev/null'],{cwd,stdio:['pipe','ignore','ignore'],
    env:{...process.env,HOME:home,TERM:'xterm-256color',CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:'1'}});
  let error=false;
  child.on('error',()=>{error=true;});
  const closed=new Promise<void>(done=>child.once('close',()=>done()));
  try {
    const deadline=Date.now()+150_000;
    while (Date.now()<deadline) {
      if (signal.aborted) throw new Error('Native teammate interrupted');
      if (error || child.exitCode!==null || child.signalCode!==null) throw new Error('Native teammate runtime exited before verified receipt');
      const receipt=await teammateReceipt(config,cwd,session,name,challenge,expected);
      if (receipt) return receipt;
      await delay(400);
    }
    throw new Error('Native teammate receipt timed out');
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}
