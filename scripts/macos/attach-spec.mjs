// The operator chooses a work card. There is no host file argument or OS file picker.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { attachmentUrl, digestOf } from '../../dist/src/specification-upload.js';

const [repo,issue] = process.argv.slice(2);
if (process.argv.length!==4 || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(issue))
  throw Error('Usage: node scripts/macos/attach-spec.mjs OWNER/REPOSITORY ISSUE');
const cardUrl='https://github.com/'+repo+'/issues/'+issue;
const handoff=(...args)=>execFileSync('docker',['exec','jam-bot-service-receiver-1','node','dist/src/specification-handoff.js',repo,issue,...args],{encoding:'utf8'});
const context=await chromium.launchPersistentContext(join(homedir(),'.jam-bot','spec-upload-profile'),{channel:'chrome',headless:false});
try {
  const page=await context.newPage();
  await page.goto(cardUrl);
  console.log('Sign in if needed, then open the comment editor on the specified issue. The helper selects the file.');
  if (await page.getByRole('link',{name:'Sign in',exact:true}).count()) {
    await page.goto('https://github.com/login?return_to='+encodeURIComponent(cardUrl));
    console.log('GitHub sign-in required in the dedicated Chrome window.');
    await page.waitForURL(cardUrl,{timeout:0});
  }
  const editor=page.getByRole('textbox',{name:/comment/i}).last();
  await editor.waitFor({timeout:180000});
  const form=editor.locator('xpath=ancestor::form[1]');
  const input=form.locator('input[type=file]');
  if (page.url()!==cardUrl || await input.count()!==1 || await editor.inputValue()!=='')
    throw Error('Expected the empty issue comment form and one attachment input');
  const packet=JSON.parse(handoff());
  const buffer=Buffer.from(packet.content,'base64');
  if (digestOf(buffer)!==packet.digest) throw Error('Corrupted specification handoff');
  // Recheck scope immediately before handing bytes to the browser. Selection starts upload.
  if (JSON.parse(handoff()).digest!==packet.digest) throw Error('Specification changed');
  await input.setInputFiles({name:packet.name,mimeType:'text/markdown',buffer});
  let body,url;
  for(let tries=0; tries<60 && !url; tries++) {
    if (page.url()!==cardUrl) throw Error('Issue page changed');
    body=await editor.inputValue();
    url=attachmentUrl(body,packet.name);
    if (!url) await delay(500);
  }
  if(!url) throw Error('Draft must contain exactly the expected attachment');
  const response=await context.request.get(url,{timeout:30000});
  if (!response.ok() || !(await response.body()).equals(buffer)) throw Error('Uploaded file differs from the approved specification');
  if (JSON.parse(handoff()).digest!==packet.digest) throw Error('Specification changed before publication');
  // Post the validated fixed body via the authenticated CLI. No text from the browser draft is submitted.
  const api=(...args)=>JSON.parse(execFileSync('gh',['api',...args],{encoding:'utf8'}));
  const owner=api('repos/'+repo).owner;
  if(api('user').id!==owner.id)throw Error('Publication requires the verified repository owner');
  const expected='['+packet.name+']('+url+')';
  const comment=api('repos/'+repo+'/issues/'+issue+'/comments','-X','POST','-f','body='+expected);
  handoff(url,String(comment.id));
  console.log(comment.html_url);
} finally { await context.close(); }
