// Destinations come exclusively from the operator's private, exact project/environment recipe.
function url({port,path}){
  if(!Number.isInteger(port)||port<1024||port>65535||typeof path!=='string'||path.length>256||
    !/^\/(?:[a-zA-Z0-9._~-]+\/?)*$/.test(path)||path.split('/').some(v=>v==='.'||v==='..'))
    throw Error('Invalid registered preview endpoint');
  return 'http://127.0.0.1:'+port+path;
}
async function probe(destination,request){
  const address=url(destination);
  try {
    const result=await request(address,{redirect:'manual',signal:AbortSignal.timeout(4000)});
    await result.body?.cancel();
    return {url:address,status:result.status};
  }catch{return {url:address,status:null};}
}
async function inspectDependency({project,service},docker){
  for(const label of [project,service])if(typeof label!=='string'||!/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(label))throw Error('Invalid Compose identity');
  const state={project,service,running:false,healthy:false,containerId:null};
  const ids=await docker(['ps','--no-trunc','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service='+service,'--format','{{.ID}}']);
  if(!ids)return state;
  if(!/^[a-f0-9]{64}$/.test(ids))throw Error('Existing dependency identity is ambiguous');
  const status=await docker(['inspect','--format','{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}unreported{{end}}',ids]);
  const [running,health]=status.split(' ');
  return {...state,containerId:ids,running:running==='true',healthy:running==='true'&&['healthy','unreported'].includes(health)};
}
export async function observeExistingPreview(environment,recipe,docker,request=fetch){
  const [web,api,dependency]=await Promise.all([probe(recipe.web,request),recipe.api&&probe(recipe.api,request),recipe.docker&&inspectDependency(recipe.docker,docker)]);
  const successful=v=>v.status!==null&&v.status>=200&&v.status<300;
  return {environment,endpoint:{address:'127.0.0.1',port:recipe.web.port},revision:null,image:null,running:web.status!==null,
    healthy:successful(web)&&(!api||successful(api))&&(!dependency||dependency.healthy),
    observation:{web,...(api?{api}:{}),...(dependency?{dependency}:{})}};
}
