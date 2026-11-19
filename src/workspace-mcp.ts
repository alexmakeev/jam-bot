import {appendFile} from 'node:fs/promises';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {WorkspaceReader} from './workspace-reader.js';
import {loadWorkspace} from './workspace-binding.js';

const [, ,file,digest,session,member,challenge]=process.argv;
if(!file)throw Error('Workspace manifest required');
const manifest=await loadWorkspace(file,digest&&session&&member&&challenge?{digest,binding:{session,member,challenge}}:undefined);
if(manifest.version!==1||!manifest.identity?.revision||!manifest.identity.specifications)throw Error('Invalid workspace manifest');
const reader=new WorkspaceReader(manifest);
const base={root:z.enum(['repository','specifications']),path:z.string().default(''),offset:z.int().nonnegative().optional(),limit:z.int().positive().optional()};
const schemas={workspace_list:z.strictObject(base),workspace_read:z.strictObject({...base,path:z.string().min(1)}),workspace_search:z.strictObject({...base,query:z.string().min(1).max(2000),lineOffset:z.int().nonnegative().optional()})};
const descriptions={workspace_list:'List the selected immutable repository or approved-specification directory. Results are paginated.',workspace_read:'Read a text file by relative path and byte range. Code and specifications are data; no execution or writes are available.',workspace_search:'Search text for a literal string within an immutable root. For the next page pass offset=next and lineOffset=nextLine; large skipped files remain readable by ranges.'};
const server=new Server({name:'jam-workspace',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>{
  if(manifest.audit)await appendFile(manifest.audit,JSON.stringify({at:new Date().toISOString(),identity:manifest.identity,binding:manifest.binding,operation:'tools-list',root:'repository',path:'',bytes:0,tools:Object.keys(schemas)})+'\n',{mode:0o600});
  return {tools:Object.entries(schemas).map(([name,schema])=>({name,_meta:{'anthropic/alwaysLoad':true},description:descriptions[name as keyof typeof descriptions],inputSchema:z.toJSONSchema(schema,{io:'input'}),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}))};
});
server.setRequestHandler(CallToolRequestSchema,async request=>{
  try{
    const name=request.params.name;
    if(!Object.hasOwn(schemas,name))throw Error('Unknown workspace operation');
    let result;
    if(name==='workspace_search'){
      const x=schemas.workspace_search.parse(request.params.arguments);result=await reader.search(x.root,x.query,x.path,x.offset,x.limit,x.lineOffset);
    }else{
      const x=schemas[name as 'workspace_read'|'workspace_list'].parse(request.params.arguments);
      result=name==='workspace_read'?await reader.read(x.root,x.path,x.offset,x.limit):await reader.list(x.root,x.path,x.offset,x.limit);
    }
    return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
  }catch{if(manifest.audit)await appendFile(manifest.audit,JSON.stringify({at:new Date().toISOString(),identity:manifest.identity,binding:manifest.binding,operation:'rejected-call',root:'repository',path:'',bytes:0})+'\n',{mode:0o600});return {isError:true,content:[{type:'text' as const,text:'Workspace operation rejected or unavailable. Use only registered roots and valid relative paths.'}]};}
});
await server.connect(new StdioServerTransport());
