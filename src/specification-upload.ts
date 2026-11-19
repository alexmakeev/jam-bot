import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {recordedArchitectSpecification} from './development-specification.js';

export const digestOf = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const specName = (issue: number, digest: string) => 'spec-'+issue+'-'+digest.slice(0,12)+'.md';

export function attachmentUrl(body: string, name: string): string | undefined {
  const match = /^\[([^\]\r\n]+)\]\((https:\/\/github\.com\/user-attachments\/(?:files\/\d+\/[\w.%-]+|assets\/[a-f0-9-]+))\)$/.exec(body.trim());
  if (match?.[1] !== name) return;
  const url = match[2]!;
  if (url.includes('/files/') && !url.endsWith('/'+name)) return;
  return url;
}

export async function prepareSpec(state: string, issue: number) {
  if (!Number.isSafeInteger(issue) || issue < 1) throw Error('Invalid issue');
  const folder = join(state,'assignments',String(issue));
  const {output} = await recordedArchitectSpecification(folder);
  if (typeof output !== 'string' || !output.trim() || Buffer.byteLength(output)>65536 || output.includes('\0')) {
    throw Error('Expected a text specification from the architect');
  }
  const digest = digestOf(output);
  const name = specName(issue,digest);
  const bytes = await readFile(join(folder,'attachments',name));
  if (!bytes.equals(Buffer.from(output))) throw Error('Staged bytes differ from the architect output');
  return {name,digest,content:bytes.toString('base64')};
}
