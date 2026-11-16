import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectAssets} from '../scripts/macos/s3-artifact.mjs';
import {validateStaticSite} from '../scripts/macos/s3-release.mjs';
test('static build rejects escaping links, mutable assets and a mismatched manifest',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'s3-proof-'));
  try{
    await mkdir(join(dir,'assets/releases/v1'),{recursive:true});await writeFile(join(dir,'index.html'),'html');
    await writeFile(join(dir,'assets/releases/v1/a.js'),'js');
    const objects=await collectAssets(dir);assert.equal(Object.keys(objects).length,2);
    await writeFile(join(dir,'build-manifest.json'),JSON.stringify(objects));assert.deepEqual(await collectAssets(dir),objects);
    await writeFile(join(dir,'build-manifest.json'),'{}');await assert.rejects(collectAssets(dir),/disagrees/);
    await rm(join(dir,'build-manifest.json'));await symlink('/etc/passwd',join(dir,'assets/releases/v1/b.js'));await assert.rejects(collectAssets(dir),/Invalid/);
    await rm(join(dir,'assets/releases/v1/b.js'));await writeFile(join(dir,'app.js'),'mutable');await assert.rejects(collectAssets(dir),/immutable/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('static deployment uses only the operator-bound resource, secret, repository and secure endpoints',()=>{
  const recipe={repoId:10,environment:'preview',tier:'staging',secrets:{store:'/host/secret'},staticSite:{bucket:'test-bucket',region:'us-east-1',credentialRef:'store',s3Endpoint:'https://s3.example',publicBase:'https://site.example/',cache:{mode:'ssh-resource',resource:'test-site',sshHost:'deployer@test-host'}}};
  const x={repoId:10,environment:'preview',secretRefs:['store']};
  assert.equal(validateStaticSite(recipe,x),recipe.staticSite);
  for(const patch of [{repoId:11},{secretRefs:[]},{secretRefs:['other']},{appVariables:{APP_BUCKET:'elsewhere'}},{endpoint:{port:10999}}])assert.throws(()=>validateStaticSite(recipe,{...x,...patch}));
  for(const patch of [{s3Endpoint:'http://example.com'},{prefix:'../'},{cache:{mode:'ssh-resource',resource:'ok; id',sshHost:'host'}}])assert.throws(()=>validateStaticSite({...recipe,staticSite:{...recipe.staticSite,...patch}},x));
});
