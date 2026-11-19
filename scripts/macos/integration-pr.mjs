// The integration candidate is immutable. Publication preserves its tested SHA.
export async function prepareIntegrationPr({repo,revision,expected,cards,git,api}) {
  if(!/^[a-f0-9]{40}$/.test(revision)||!expected)throw Error('PR publication requires an existing dev branch');
  const branch='jam/integration-'+revision;
  const remote=await git(['ls-remote','origin','refs/heads/'+branch]);
  if(remote && remote.split(/\s/)[0]!==revision)throw Error('Integration PR branch changed');
  if(!remote)await git(['push','--force-with-lease=refs/heads/'+branch+':','origin',revision+':refs/heads/'+branch]);
  const path='repos/'+repo+'/pulls';
  const matches=await api(path+'?state=all&base=dev&head='+encodeURIComponent(repo.split('/')[0]+':'+branch));
  if(matches.length>1)throw Error('Conflicting integration pull requests');
  const pr=matches[0]??await api(path,'POST',{
    title:'Integrate approved work into dev',head:branch,base:'dev',
    body:'Tested candidate `'+revision+'`.\n\nWork cards: '+cards.map(card=>'#'+card.issue).join(', ')+'.\n\nIssues are closed separately after verified integration.'
  });
  if(pr.head?.sha!==revision||pr.base?.ref!=='dev'||pr.base?.repo?.full_name?.toLowerCase()!==repo.toLowerCase()||pr.state==='closed'&&!pr.merged_at)
    throw Error('Integration pull request does not match tested candidate');
  return pr;
}

export async function verifyIntegrationPr(repo,number,revision,api,{attempts=6,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  for(let attempt=0;attempt<attempts;attempt++){
    const pr=await api('repos/'+repo+'/pulls/'+number);
    if(pr.number!==number||pr.head?.sha!==revision||pr.base?.ref!=='dev'||pr.base?.repo?.full_name?.toLowerCase()!==repo.toLowerCase())
      throw Error('Integration PR merge requires reconciliation');
    if(pr.merged)return {number:pr.number,url:pr.html_url,sha:revision};
    if(attempt+1<attempts)await pause(1000*2**attempt);
  }
  throw Error('Integration PR merge requires reconciliation');
}

// Recovery observes the existing branch and PR; it never creates a PR or pushes.
export async function confirmIntegrationPublication(repo,revision,api){
  const dev=await api('repos/'+repo+'/git/ref/heads/dev');
  const head=dev.object?.sha;
  if(!/^[a-f0-9]{40}$/.test(head??'')||!/^[a-f0-9]{40}$/.test(revision))throw Error('Publication requires reconciliation');
  if(head!==revision){
    const comparison=await api('repos/'+repo+'/compare/'+revision+'...'+head);
    if(comparison.status!=='ahead'||comparison.merge_base_commit?.sha!==revision)throw Error('Publication requires reconciliation');
  }
  const prs=await api('repos/'+repo+'/pulls?state=closed&base=dev&head='+encodeURIComponent(repo.split('/')[0]+':jam/integration-'+revision));
  if(prs.length!==1)throw Error('Integration PR merge requires reconciliation');
  return verifyIntegrationPr(repo,prs[0].number,revision,api);
}
