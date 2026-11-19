export async function fetchValidationBase(git, {action,base,expected}, dev, defaultBranch) {
  const worker = action === 'test-head' || action === 'test-red';
  if (!worker && dev !== expected) throw Error('Remote dev changed during validation');
  const baseRef = dev ? 'dev' : await defaultBranch();
  await git(['fetch','--no-tags','origin','refs/heads/'+baseRef+':refs/heads/base']);
  if (worker) await git(['merge-base','--is-ancestor',base,'refs/heads/base']);
  else if (await git(['rev-parse','refs/heads/base']) !== base) throw Error('Candidate base is stale');
}

const unitTests = listing => listing.split('\0').filter(path => /^(?:test|tests)\/.*\.test\.[cm]?[jt]s$/.test(path));

export async function overlayRedTests(git, worktreeGit, revision) {
  const testFiles = unitTests(await git(['ls-tree','-r','--name-only','-z',revision]));
  if (!testFiles.length) throw Error('No unit tests for RED validation');
  const candidateTests = new Set(testFiles);
  const removedTests = unitTests(await worktreeGit(['ls-files','-z'])).filter(path => !candidateTests.has(path));
  if (removedTests.length) await worktreeGit(['rm','--',...removedTests]);
  await worktreeGit(['checkout',revision,'--',...testFiles]);
}

// Only the exact dev-anchored integration spine can inherit changes from earlier members.
function integrationSpine(parents, base, candidate) {
  const spine = new Set();
  let revision = candidate;
  while (parents.has(revision)) {
    spine.add(revision);
    revision = parents.get(revision)[0];
  }
  return revision === base ? spine : new Set();
}

export async function verifyCandidateScope(git, {action,base,sha}, files) {
  const history = await git(['rev-list','--parents',base+'..'+sha]);
  const parents = new Map(history.split('\n').filter(Boolean).map(line => {
    const [revision,...ancestors] = line.split(' ');
    return [revision,ancestors];
  }));
  const integration = action === 'test' || action === 'publish';
  const spine = integration ? integrationSpine(parents,base,sha) : new Set();
  const verifyPaths = async revisions => {
    const paths = (await git(['diff-tree','--no-commit-id','--name-only','--no-renames','-r','-z',...revisions])).split('\0').filter(Boolean);
    if (paths.some(path => !files.has(path))) throw Error('Commit outside approved file scope');
  };
  for (const [revision,ancestors] of parents) {
    if (spine.has(revision) && ancestors.length === 2 && parents.has(ancestors[1])) {
      await verifyPaths([ancestors[0],revision]);
    } else {
      await verifyPaths(['--root','-m',revision]);
    }
  }
  if (integration) await verifyPaths([base,sha]);
}
