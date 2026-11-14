// Staging and byte checks for native browser uploads using the operator's existing login.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachmentUrl } from '../../dist/src/specification-upload.js';

const [stage,repo,issue,body] = process.argv.slice(2);
if (!['stage','clipboard','publish'].includes(stage) || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^[1-9]\d*$/.test(issue ?? ''))
  throw Error('Expected stage|clipboard|publish OWNER/REPO ISSUE [draft Markdown]');
const handoff = (...args) => execFileSync('docker',['exec','jam-bot-service-receiver-1','node','dist/src/specification-handoff.js',repo,issue,...args],{encoding:'utf8'});
const packet = JSON.parse(handoff());
const hash = data => createHash('sha256').update(data).digest('hex');
const bytes = Buffer.from(packet.content,'base64');
if (hash(bytes)!==packet.digest || packet.name!=='spec-'+issue+'-'+packet.digest.slice(0,12)+'.md' || basename(packet.name)!==packet.name)
  throw Error('Invalid handoff');
const dir = join(homedir(),'.jam-bot','attachment-staging',repo,issue,packet.digest);
const path = join(dir,packet.name);
if (stage==='stage') {
  mkdirSync(dir,{recursive:true,mode:0o700});
  if (!readdirSync(dir).length) {
    writeFileSync(path,bytes,{mode:0o400,flag:'wx'});
    chmodSync(dir,0o500);
  }
}
if (readdirSync(dir).join('')!==packet.name || !lstatSync(path).isFile() || !readFileSync(path).equals(bytes)) throw Error('Unexpected local staging contents');
if (stage==='stage') console.log(dir);
if (stage==='clipboard') {
  execFileSync('/usr/bin/swift',[join(dirname(fileURLToPath(import.meta.url)),'spec-clipboard.swift'),path],{stdio:'inherit'});
  console.log('Verified the selected file and bytes for https://github.com/'+repo+'/issues/'+issue);
}
if (stage==='publish') {
  const url = attachmentUrl(body ?? '',packet.name);
  if (!url) throw Error('Expected the single exact attachment reference');
  const download=join(homedir(),'Downloads',packet.name);
  if(!lstatSync(download).isFile() || !readFileSync(download).equals(bytes)) throw Error('Downloaded bytes differ from the specification');
  const api=(...args)=>JSON.parse(execFileSync('gh',['api',...args],{encoding:'utf8'}));
  const repository=api('repos/'+repo);
  // Compare immutable download metadata without printing transient signed query parameters.
  const encoded=execFileSync('/usr/bin/xattr',['-px','com.apple.metadata:kMDItemWhereFroms',download],{encoding:'utf8'});
  const sources=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-','-'],{
    input:Buffer.from(encoded.replace(/\s/g,''),'hex'),encoding:'utf8'
  }));
  const id=new URL(url).pathname.match(/^\/user-attachments\/files\/(\d+)\//)?.[1];
  const sameSource=sources.some(source=>{
    const u=new URL(source);
    return source===url || (id && u.origin==='https://objects.githubusercontent.com' &&
      new RegExp('^/github-production-repository-file-[a-f0-9]+/'+repository.id+'/'+id+'$').test(u.pathname));
  });
  if (!sameSource) throw Error('Downloaded file did not come from this hosted attachment');
  const owner=repository.owner;
  if(api('user').id!==owner.id || JSON.parse(handoff()).digest!==packet.digest) throw Error('Owner or specification changed');
  const base='repos/'+repo+'/issues/'+issue+'/comments';
  const pages=api('--paginate','--slurp',base+'?per_page=100');
  const saved=pages.flat().find(c=>c.user.id===owner.id && c.body===body) ??
    api(base,'-X','POST','-f','body='+body);
  handoff(url,String(saved.id));
  console.log(saved.html_url);
}
