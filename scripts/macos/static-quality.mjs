import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

export const gateVersion='development-static-v1';
export const toolContract={typescript:'7.0.2','@biomejs/biome':'2.3.8','@babel/parser':'7.28.5','@types/node':'22.20.5',parse5:'7.2.1',postcss:'8.5.6'};
export const codeFile=path=>/\.(?:[cm]?[jt]sx?|html?|css|scss|vue|svelte)$/.test(path);
const scriptFile=path=>/\.[cm]?[jt]sx?$/.test(path);
export function introducedComments(parse,path,before,after){
  const options={sourceType:'unambiguous',plugins:/\.[cm]?tsx?$/.test(path)?['typescript',...(path.endsWith('.tsx')?['jsx']:[])]:path.endsWith('.jsx')?['jsx']:[]};
  const comments=text=>parse(text,options).comments.map(comment=>text.slice(comment.start,comment.end));
  const available=new Map();
  for(const comment of comments(before))available.set(comment,(available.get(comment)??0)+1);
  return comments(after).filter(comment=>{const count=available.get(comment)??0;if(count){available.set(comment,count-1);return false;}return true;});
}
export function documentComments(path,text,{parseHtml,parseScript,parseCss}){
  const css=value=>{const comments=[];parseCss(value).walkComments(node=>comments.push(value.slice(node.source.start.offset,node.source.end.offset)));return comments;};
  if(path.endsWith('.css'))return css(text);
  if(!/\.html?$/.test(path))throw Object.assign(Error('Comment parser unavailable for '+path),{unavailable:true});
  const comments=[];
  const visit=node=>{
    if(node.nodeName==='#comment')comments.push(text.slice(node.sourceCodeLocation.startOffset,node.sourceCodeLocation.endOffset));
    if(node.tagName==='script'){
      const kind=node.attrs?.find(attr=>attr.name==='type')?.value??'';
      const source=(node.childNodes??[]).filter(child=>child.nodeName==='#text').map(child=>child.value).join('');
      if(!kind||kind==='module'||/javascript|ecmascript/.test(kind))comments.push(...parseScript(source,{sourceType:'unambiguous'}).comments.map(comment=>source.slice(comment.start,comment.end)));
    }
    if(node.tagName==='style')comments.push(...css((node.childNodes??[]).filter(child=>child.nodeName==='#text').map(child=>child.value).join('')));
    for(const child of node.childNodes??[])visit(child);
    if(node.content)visit(node.content);
  };visit(parseHtml(text,{sourceCodeLocationInfo:true}));return comments;
}

export async function staticQuality(input,tools){
  const checks=[];
  const check=async(name,operation)=>{
    try{const detail=await operation();checks.push({name,status:'passed',detail});}
    catch(error){checks.push({name,status:error.unavailable?'unavailable':'failed',detail:error.message});}
  };
  await check('toolchain',async()=>{
    for(const [tool,version] of Object.entries(toolContract))if(await tools.version(tool)!==version)throw Object.assign(Error('Required trusted tool '+tool+'@'+version+' is unavailable'),{unavailable:true});
    return toolContract;
  });
  if(checks[0].status==='passed'){
    await check('generated-code-comments',async()=>{
      for(const file of input.changed.filter(codeFile)){
        const before=input.baseline[file]??'',after=await tools.source(file);
        let added;
        if(scriptFile(file))added=introducedComments(tools.parse,file,before,after);
        else{
          if(!tools.documentComments)throw Object.assign(Error('Comment parser unavailable for '+file),{unavailable:true});
          const available=new Map();for(const token of tools.documentComments(file,before))available.set(token,(available.get(token)??0)+1);
          added=tools.documentComments(file,after).filter(token=>{const count=available.get(token)??0;if(count){available.set(token,count-1);return false;}return true;});
        }
        if(added.length)throw Error('New code comments in '+file);
      }
      return 'No introduced supported-language comments';
    });
    const files=input.files.filter(codeFile).map(file=>'./'+file);
    await check('lint',()=>tools.run('biome',['lint','--config-path=/tmp/jam-quality',...files]));
    await check('format',()=>tools.run('biome',['format','--config-path=/tmp/jam-quality',...files]));
    await check('types',()=>tools.run('tsc',['typescript-build','typescript-compiled'].includes(input.recipe)?['-p','tsconfig.json','--noEmit','--incremental','false']:['--allowJs','--checkJs','--allowImportingTsExtensions','--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--skipLibCheck','--typeRoots','/opt/jam-bot/node_modules/@types','--types','node',...input.files.filter(scriptFile).map(file=>'./'+file)]));
  }else{
    for(const name of ['generated-code-comments','lint','format','types'])checks.push({name,status:'unavailable',detail:'Trusted toolchain unavailable'});
  }
  return {version:gateVersion,revision:input.sha,execution:input.execution,checks,passing:checks.every(check=>check.status==='passed')};
}

async function main(){
  const input=JSON.parse(await readFile('/gate/input.json','utf8'));
  const root='/opt/jam-bot/node_modules';
  const require=createRequire('/opt/jam-bot/package.json');
  let parser;
  const result=await staticQuality(input,{
    version:async tool=>{try{return JSON.parse(await readFile(root+'/'+tool+'/package.json','utf8')).version;}catch{ return undefined;}},
    parse:(...args)=>(parser??=require('@babel/parser')).parse(...args),
    documentComments:(path,text)=>documentComments(path,text,{parseHtml:require('parse5').parse,parseScript:require('@babel/parser').parse,parseCss:require('postcss').parse}),
    source:file=>readFile(file,'utf8'),
    run:async(tool,args)=>{
      await mkdir('/tmp/jam-quality',{recursive:true});
      await writeFile('/tmp/jam-quality/biome.json',JSON.stringify({files:{ignoreUnknown:false},formatter:{enabled:true},linter:{enabled:true,rules:{recommended:true}},assist:{enabled:false}}));
      const binary=tool==='biome'?root+'/@biomejs/biome/bin/biome':root+'/.bin/tsc';
      try{
        const {stdout,stderr}=await promisify(execFile)(binary,args,{timeout:60000,maxBuffer:512*1024});
        return (stdout+stderr).slice(-1200);
      }catch(error){throw Error(error.message.slice(0,800)+'\n'+String(error.stdout??'').slice(-1800)+'\n'+String(error.stderr??'').slice(-1800));}
    },
  });
  process.stdout.write('Quality results: '+JSON.stringify(result)+'\n');
  if(!result.passing)process.exitCode=1;
  else process.stdout.write('Quality gate: '+gateVersion+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
