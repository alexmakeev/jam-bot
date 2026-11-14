// A locked, owner-authored work card carries an explicit, versioned scope.
export interface ProfileCard {
  kind: 'assignment' | 'consultation' | 'development';
  task: string;
  files: string[];
}

const header = 'I approve this Leo Developer work card.';

export function parseProfileCard(body: string): ProfileCard | undefined {
  if (body.length > 8192) return;
  const match = body.match(/^I approve this Leo Developer work card\.\n\nClass: (assignment|consultation|development)\n([\s\S]+)$/);
  if (!match) return;
  const kind = match[1] as ProfileCard['kind'];
  const [scope, ...parts] = match[2]!.split('\n\n');
  if (!scope?.startsWith('Files: ')) return;
  const files = scope.slice(7) === 'none' ? [] : scope.slice(7).split(', ');
  if (files.length > 32 || files.some(file => !/^[\w.-]+(?:\/[\w.-]+)*$/.test(file) ||
      file.split('/').some(part => part.startsWith('.') || part.toLowerCase() === 'node_modules'))) return;
  if (new Set(files).size !== files.length || (kind === 'development') !== Boolean(files.length)) return;
  const task = parts.join('\n\n').trim();
  if (!task || task.length > 6000) return;
  return {kind,files,task};
}

export function formatProfileCard(card: ProfileCard): string {
  const body = [header, 'Class: ' + card.kind + '\nFiles: ' + (card.files.join(', ') || 'none'), card.task].join('\n\n');
  if (!parseProfileCard(body)) throw new Error('Invalid Leo Developer work card');
  return body;
}
