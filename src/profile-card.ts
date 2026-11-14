export const profileKinds = ['assignment','consultation','development'] as const;
export type ProfileKind = typeof profileKinds[number];
export interface ProfileCard {
  kind: ProfileKind;
  task: string;
  files: string[];
}
const legacyHeader = 'I approve this Leo Developer work card.';

function allowedFiles(text:string) {
  if (!text.trim() || text.trim().toLowerCase()==='none') return [];
  const files=text.split(',').map(file=>file.trim().replace(/^`([^`]+)`$/,'$1'));
  if(files.length>32 || new Set(files).size!==files.length || files.some(file=>file.length>240 ||
    !file.split('/').every(part=>/^[a-zA-Z0-9_+-][a-zA-Z0-9_.+-]*$/.test(part) && part.toLowerCase()!=='node_modules'))) return;
  return files;
}

// GitHub Task assignment carries authorization. These optional hints only choose the bounded work.
export function parseTaskCard(title:string,body:string,labelKind?:ProfileKind,defaultKind:ProfileKind='development'):ProfileCard|undefined {
  if(body.length>8192 || title.length>256 || !title.trim())return;
  let text=body.replaceAll('\r\n','\n').trim();
  if(text.startsWith(legacyHeader+'\n'))text=text.slice(legacyHeader.length).trimStart();
  const lines=text.split('\n');
  let declared:ProfileKind|undefined;
  let files:string[]|undefined;
  while(lines.length){
    const line=lines[0]!.trim();
    const hint=/^(Class|Files):\s*(.*)$/i.exec(line);
    if(!hint)break;
    lines.shift();
    if(hint[1]!.toLowerCase()==='class'){
      const value=hint[2]!.toLowerCase() as ProfileKind;
      if(declared || !profileKinds.includes(value))return;
      declared=value;
    }else{
      if(files!==undefined)return;
      files=allowedFiles(hint[2]!);
      if(!files)return;
    }
  }
  if(labelKind && (!profileKinds.includes(labelKind) || (declared && labelKind!==declared)))return;
  const kind=labelKind ?? declared ?? (files?.length ? 'development' : defaultKind);
  if(kind!=='development' && files?.length)return;
  const task=lines.join('\n').trim() || title.trim();
  if(task.length>6000)return;
  return {kind,task,files:files??[]};
}

// Read historical experimental cards without treating their text as authorization.
export function parseProfileCard(body:string):ProfileCard|undefined {
  if(!body.startsWith(legacyHeader+'\n\nClass:'))return;
  const result=parseTaskCard('Legacy work card',body);
  if(!result || result.task==='Legacy work card' || (result.kind==='development')!==Boolean(result.files.length))return;
  return result;
}
export function formatProfileCard(card:ProfileCard):string {
  const body=[legacyHeader,'Class: '+card.kind+'\nFiles: '+(card.files.join(', ')||'none'),card.task].join('\n\n');
  if(!parseProfileCard(body))throw new Error('Invalid Leo Developer work card');
  return body;
}
