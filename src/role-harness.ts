import { randomUUID } from 'node:crypto';
import { runNativeJob } from './native-teammate.js';

const responsibilities = {
  designer: 'Design a usable interface for the approved task. Specify layout, typography, color, interaction and accessibility within the existing project.',
  architect: 'Prepare a concise implementation specification and testable acceptance criteria.',
  assignment: 'Carry out the approved direct assignment and return its requested result.',
  developer: 'Implement the assigned work using the provided project files. Return the requested artifact exactly.',
  integrator: 'Evaluate the candidate against the specification and supplied test evidence. Report remaining failures accurately.',
  consultant: 'Answer the approved consultation question with a concise recommendation and its reasoning.',
};

export type StageRole = keyof typeof responsibilities;
export interface RoleStage {
  role: StageRole;
  state: string;
  cwd: string;
  session: string;
  issue: number;
  input: string;
  signal: AbortSignal;
}

export async function runRoleStage({role,state,cwd,session,issue,input,signal}: RoleStage) {
  if (!Object.hasOwn(responsibilities,role) || !Number.isSafeInteger(issue) || issue<1 ||
      !input.trim() || Buffer.byteLength(input)>80000) throw new Error('Invalid role stage or oversized input');
  const challenge = randomUUID();
  const agentType='jam-'+role;
  const name=role+'-'+issue+'-'+challenge.slice(0,6);
  const system = responsibilities[role]+' Your only tool is SendMessage. Return the work product to main in one plain text message. '+
    'Start the message with the supplied challenge on its own line. Follow it with the requested output. Do not add markdown fences unless asked.';
  const prompt = 'Start exactly one native in-process teammate using Agent with name='+name+' and subagent_type='+agentType+
    '. Forward the following stage input verbatim, including the challenge and output contract. Wait for its mailbox reply. '+
    'Do not produce the work product yourself. The teammate must send its result using SendMessage to main. Its first line must be exactly '+challenge+
    '. The remaining lines must be the requested artifact, without a preamble. Stage input (JSON string): '+JSON.stringify(input);
  return runNativeJob({state,cwd,session,name,agentType,challenge,system,prompt,signal});
}

// A stage never receives a filesystem tool. Only the supervisor applies explicitly allowed text files.
export { applyRoleFiles } from './role-files.js';
