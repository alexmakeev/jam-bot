export const unitEvidenceVersion='unit-assertions-v2';

export function classifyUnitEvents(events){
  let passed=0,failed=0,assertions=0,aggregates=0,skipped=0,todo=0,suites=0;
  const failures=[];
  for(const {type,data} of events){
    if(type==='test:pass'){
      if(data?.skip)skipped++;
      else if(data?.todo)todo++;
      else if(data?.details?.type==='suite')suites++;
      else passed++;
    }
    if(type!=='test:fail')continue;
    const error=data.details?.error;
    if(error?.failureType==='subtestsFailed'){aggregates++;continue;}
    failed++;
    const assertion=error?.code==='ERR_ASSERTION'||(error?.failureType==='testCodeFailure'&&error?.cause?.code==='ERR_ASSERTION');
    if(assertion)assertions++;
    if(failures.length<20)failures.push({name:String(data.name??'').slice(0,160),assertion,code:error?.cause?.code??error?.code,failureType:error?.failureType,message:String(error?.cause?.message??error?.message??'Unknown unit failure').slice(0,400)});
  }
  return {version:unitEvidenceVersion,passed,failed,assertions,aggregates,skipped,todo,suites,assertionOnly:failed>0&&assertions===failed,failures};
}

export default async function* unitReporter(source){
  const relevant=[];
  let overflow=false;
  for await(const event of source){
    if(!['test:pass','test:fail'].includes(event.type))continue;
    if(relevant.length>=100000){overflow=true;continue;}
    const error=event.data.details?.error;
    relevant.push({type:event.type,data:{name:String(event.data.name??'').slice(0,160),skip:Boolean(event.data.skip),todo:Boolean(event.data.todo),details:{type:event.data.details?.type,error:error?{code:error.code,failureType:error.failureType,message:String(error.message??'').slice(0,400),cause:error.cause?{code:error.cause.code,message:String(error.cause.message??'').slice(0,400)}:undefined}:undefined}}});
  }
  const result=classifyUnitEvents(relevant);
  if(overflow){result.assertionOnly=false;result.incomplete=true;}
  yield 'Unit results: '+JSON.stringify(result)+'\n';
  yield '# pass '+result.passed+'\n# fail '+(result.failed+result.aggregates)+'\n';
  if(result.assertionOnly)yield 'AssertionError: verified assertion-only RED\n';
}
