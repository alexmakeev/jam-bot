import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ManagementError } from './management-contract.js';
import { withEnvironmentAuthority } from './environment-runner.js';

export interface ManagementOperations {
  operations: ReadonlyArray<{name:string; description:string; input:z.ZodObject; output:z.ZodObject; mutate:boolean}>;
  invoke:(name:string,input:unknown)=>Promise<Record<string,unknown>>;
}
export type ManagementHandler = (req:IncomingMessage,res:ServerResponse)=>Promise<void>;
const prefix='/api/v1/operations/';
const digest=(text:string)=>createHash('sha256').update(text).digest();
class HttpError extends Error { constructor(readonly status:number,message:string){super(message);} }

const resources=[
  ['GET','/status','server_status'],['GET','/topics','list_topics'],['POST','/topics','connect_project'],
  ['GET','/installations','list_installations'],['GET','/installations/{installationId}/projects','available_projects'],
  ['GET','/topics/{repoId}','topic_status'],['PATCH','/topics/{repoId}','configure_topic'],
  ['GET','/topics/{repoId}/environments','environment_list'],['GET','/topics/{repoId}/environments/{environment}','environment_get'],
  ['PUT','/topics/{repoId}/environments/{environment}','environment_upsert'],['GET','/topics/{repoId}/environments/{environment}/status','environment_status'],
  ['POST','/topics/{repoId}/environments/{environment}/deployments','start_environment_deployment'],
  ['GET','/topics/{repoId}/operations/{requestId}','operation_status']
].map(([method,path,operation])=>({method:method!,path:'/api/v1'+path,operation:operation!}));
function params(path:string){return [...path.matchAll(/\{(\w+)\}/g)].map(m=>m[1]!);}
function pathParams(template:string,path:string) {
  const keys=params(template),match=new RegExp('^'+template.replace(/\{\w+\}/g,'([^/]+)')+'$').exec(path);
  if(!match)return;
  try {return Object.fromEntries(keys.map((key,i)=>[key,decodeURIComponent(match[i+1]!)]));}
  catch {throw new HttpError(400,'Invalid URL encoding');}
}
function openapi(api:ManagementOperations) {
  const json=(schema:unknown)=>({'application/json':{schema}});
  const errorContent=json({type:'object',required:['error'],properties:{error:{type:'string'}}});
  const errors=Object.fromEntries(Object.entries({400:'Invalid request',401:'Bearer credential required',403:'Origin or host rejected',
    404:'Unknown resource',405:'Method not allowed',409:'Target or state conflict',413:'Request too large',415:'JSON content required',
    500:'Unexpected service error',503:'Dependency unavailable'}).map(([status,description])=>[status,{description,content:errorContent}]));
  const paths:Record<string,Record<string,unknown>>={};
  for(const op of api.operations) {
    paths[prefix+op.name]={post:{operationId:op.name,description:op.description,'x-mutating':op.mutate,
      requestBody:{required:true,content:json(z.toJSONSchema(op.input,{io:'input'}))},
      responses:{200:{description:'Operation result',content:json(z.toJSONSchema(op.output))},...errors}}};
    for(const route of resources.filter(r=>r.operation===op.name)){
      const schema=z.toJSONSchema(op.input,{io:'input'}),fields={...schema.properties},inPath=params(route.path);
      const parameters=Object.entries(fields).filter(([key])=>inPath.includes(key)||route.method==='GET')
        .map(([name,schemaValue])=>({name,in:inPath.includes(name)?'path':'query',required:inPath.includes(name)||!!schema.required?.includes(name),schema:schemaValue}));
      for(const key of inPath)delete fields[key];
      (paths[route.path]??={})[route.method.toLowerCase()]={operationId:'rest_'+op.name,description:op.description,parameters,
        ...(route.method==='GET'?{}:{requestBody:{required:true,content:json({...schema,properties:fields,required:(schema.required??[]).filter(key=>!inPath.includes(key))})}}),
        responses:{200:{description:'Operation result',content:json(z.toJSONSchema(op.output))},...errors}};
    }
  }
  return {openapi:'3.1.0',info:{title:'JAM-Bot management API',version:'1.0.0'},paths,
    security:[{ownerBearer:[]}],components:{securitySchemes:{ownerBearer:{type:'http',scheme:'bearer'}}}};
}

function send(res:ServerResponse,status:number,data:unknown) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(data));
}

async function body(req:IncomingMessage):Promise<unknown> {
  if(req.headers['content-type']?.split(';')[0]?.trim()!=='application/json')throw new HttpError(415,'Expected application/json');
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})) {
    size+=chunk.length;
    if(size>262144)throw new HttpError(413,'Request exceeds 256 KiB');
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'Invalid JSON');}
}

function publicError(err:unknown) {
  if(err instanceof ManagementError)return {status:err.status,message:err.message,code:err.code};
  if(err instanceof z.ZodError)return {status:400,message:'Invalid operation input'};
  if(err instanceof HttpError)return {status:err.status,message:err.message};
  // Domain errors expose an explicit safe status and message. Never serialize arbitrary exceptions.
  return {status:500,message:'Management operation failed'};
}

export function managementTransport(api:ManagementOperations,token:string,authorities:string[]):ManagementHandler {
  if(!/^sha256:[a-f0-9]{64}$/.test(token) && !/^[A-Za-z0-9_~.+/=-]{32,512}$/.test(token))throw new Error('Management requires a bearer token of at least 32 characters');
  const hosts=new Set(authorities.map(h=>h.trim().toLowerCase()));
  if(!hosts.size || [...hosts].some(h=>!h || /[\s\/@?#]/.test(h) || !URL.canParse('https://'+h)))
    throw new Error('Management requires an explicit host allowlist');
  const secret=token.startsWith('sha256:') ? Buffer.from(token.slice(7),'hex') : digest(token);
  const doc=openapi(api);
  const operations=new Map(api.operations.map(op=>[op.name,op]));
  const run=async(name:string,input:unknown)=>{
    const op=operations.get(name);
    if(!op)throw new HttpError(404,'Unknown operation');
    const result=await api.invoke(name,op.input.parse(input));
    if(!op.output.safeParse(result).success)throw new HttpError(500,'Invalid operation result');
    return result;
  };
  return async(req,res)=>{
    const path=req.url;
    const mcp=path==='/mcp';
    try {
      if(!hosts.has(req.headers.host?.toLowerCase() ?? '') || req.headers.origin!==undefined)throw new HttpError(403,'Untrusted host or browser origin');
      const bearer=/^Bearer ([A-Za-z0-9_~.+/=-]{32,512})$/.exec(req.headers.authorization ?? '')?.[1];
      if(!bearer || !timingSafeEqual(secret,digest(bearer))) {
        res.setHeader('www-authenticate','Bearer realm="JAM-Bot management"');
        throw new HttpError(401,'Valid bearer credential required');
      }
      if(path==='/api/v1/openapi.json' && req.method==='GET'){send(res,200,doc);return;}
      if(path?.startsWith('/api/v1/') && !path.startsWith(prefix) && path!=='/api/v1/openapi.json'){
        const url=new URL(path,'http://localhost');
        const matches=resources.filter(route=>operations.has(route.operation) && pathParams(route.path,url.pathname));
        if(!matches.length)throw new HttpError(404,'Unknown endpoint');
        const route=matches.find(route=>route.method===req.method);
        if(!route){res.setHeader('allow',matches.map(r=>r.method).join(', '));throw new HttpError(405,'Method not allowed');}
        if(route.method!=='GET' && url.search)throw new HttpError(400,'Mutation parameters belong in the JSON body');
        const input=route.method==='GET'?{}:z.record(z.string(),z.unknown()).parse(await body(req));
        const spec=z.toJSONSchema(operations.get(route.operation)!.input,{io:'input'});
        const seen=new Set<string>();
        for(const [key,value] of [...Object.entries(pathParams(route.path,url.pathname)!),...url.searchParams]){
          if(!Object.hasOwn(spec.properties??{},key) || seen.has(key))throw new HttpError(400,'Unknown or repeated request parameter');
          seen.add(key);
          const property=spec.properties![key];
          const parsed=typeof property==='object' && property.type==='integer' && /^(0|[1-9][0-9]*)$/.test(value)?Number(value):value;
          if(Object.hasOwn(input,key) && input[key]!==parsed)throw new HttpError(400,'Conflicting target parameter');
          input[key]=parsed;
        }
        send(res,200,await withEnvironmentAuthority(bearer,()=>run(route.operation,input)));return;
      }
      if(!mcp && !path?.startsWith(prefix) && path!=='/api/v1/openapi.json')throw new HttpError(404,'Unknown endpoint');
      if(req.method!=='POST' || path==='/api/v1/openapi.json'){res.setHeader('allow',path==='/api/v1/openapi.json'?'GET':'POST');throw new HttpError(405,'Method not allowed');}
      const input=await body(req);
      if(!mcp) {send(res,200,await withEnvironmentAuthority(bearer,()=>run(path!.slice(prefix.length),input)));return;}
      const server=new McpServer({name:'jam-bot',version:'1.0.0'});
      for(const op of api.operations) {
        server.registerTool(op.name,{description:op.description,inputSchema:op.input,outputSchema:op.output,annotations:{readOnlyHint:!op.mutate}},
          async args=>{
            try {
              const value=await withEnvironmentAuthority(bearer,()=>run(op.name,args));
              return {structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};
            }catch(err){return {isError:true,content:[{type:'text',text:publicError(err).message}]};}
          });
      }
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.once('close',()=>{void server.close().catch(()=>{});});
      await server.connect(transport);
      await transport.handleRequest(req,res,input);
    }catch(err){
      if(res.headersSent){res.end();return;}
      const {status,message,code}=publicError(err);
      if(status===413)res.setHeader('connection','close');
      send(res,status,mcp?{jsonrpc:'2.0',id:null,error:{code:status===400?-32700:-32000,message}}:{error:message,code});
    }
  };
}

export async function configuredManagement(factory:()=>Promise<ManagementOperations>) {
  const file=process.env.JAM_MANAGEMENT_TOKEN_FILE;
  if(!file)return;
  const token=(await readFile(file,'utf8')).trim();
  return managementTransport(await factory(),token,(process.env.JAM_MANAGEMENT_HOSTS ?? '').split(','));
}
