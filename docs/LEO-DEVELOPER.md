# Leo Developer work profile

Create an open issue with native type **Task**, or assign that type to a finished draft. The service checks the signed actor's current repository write access and locks the conversation. A draft without the Task type can be edited before approval.

## Work cards

Use the title and description to explain the work. The repository's Leo Developer profile defaults to development. List the approved editable paths in a leading `Files: src/example.ts, tests/example.test.ts` line before the task description. An explicit `Class: assignment` or `Class: consultation` line can select another route. A development card can include a leading `Design: requested` line. Leo requests a visual brief from a named designer and supplies it to the architect before the implementation specification. Ordinary tasks require no class label or approval phrase.

| Class | Work and completion |
| --- | --- |
| Assignment | A named teammate carries out the request and returns its deliverable to Leo. The service posts the result and closes the issue. |
| Consultation | A named consultant answers the approved question. The issue closes with the recommendation. |
| Development | The architect prepares a specification. The developer receives the scope and accepted specification, edits the authorized files in a separate worktree, and submits a tested revision for review. Leo groups ready revisions for the integrator. The service closes the cards after the tested candidate reaches dev. |

The native Task type and local approval record identify the work. The service adds only the current phase label. The active phase appears as one of `status:queued`, `status:planning`, `status:in-progress`, `status:in-validation` or `status:blocked`. The provider's closed state records completion. See [PRD JB-20](PRD.md) for the batching policy.

## Specification handoff on GitHub

The service attaches the architect’s English Markdown to the original Task using a native GitHub issue artifact. The installed GitHub App needs Issues write permission. A short comment links to the artifact above the activity timeline. Readers can open the document there or export the Markdown using `gh issue artifact download ISSUE ARTIFACT_NUMBER --output spec.md`.

Before handing the specification to the developer, the worker checks the repository ID, work card, App publisher, artifact name and exact UTF-8 bytes against the architect output. It verifies the timeline comment on the same issue. An on-disk publication ledger records the artifact and comment IDs. After an uncertain response, the worker reconciles against GitHub before continuing. See [GitHub issue artifacts](https://docs.github.com/en/rest/issues/artifacts).

## Acceptance environment

The test profile targets TypeScript using the Node test runner. The publisher reads a private repository on the machine and shares a Git bundle with the local service. A separate container executes the candidate tests with networking disabled and the candidate checkout mounted read-only. The publisher checks the remote base before updating the test repository's dev branch. Each native role sends its result to the repository coordinator. The local role receipts retain the team identity and the matching mailbox exchange.

## Verified run

The [assignment](https://github.com/alexmakeev/jam-bot-test/issues/10) and [consultation](https://github.com/alexmakeev/jam-bot-sandbox/issues/3) closed with their respective teammate outputs. The [development issue](https://github.com/alexmakeev/jam-bot-sandbox/issues/4) recorded planning, active work, waiting for integration, validation, a blocked review, resumed validation and closure. The architect's specification was attached through GitHub's web form. The operator verified its bytes and recorded the receipt. The integrator initially rejected the test evidence. After the runner supplied a fuller report, the operator retried the same revision. Eight candidate tests passed. The [verified revision](https://github.com/alexmakeev/jam-bot-sandbox/commit/d90b1aa26aa344c2bbc1539932eb8fc672857ab0) reached dev and the clean feature worktree and branch were removed.

Before an architect opens a worktree, the service checks the Task’s approved file list against earlier revisions in final validation. An overlapping Task waits for the earlier integration, then starts from the updated development branch. Tasks with disjoint file lists can start during validation. A conflict caused by another writer is recorded with the original branch and worktree for reconciliation.

The live integration contained one ready task. The scheduler tests cover larger batches, including sixteen readying branches processed as ten followed by six, the fifteen-branch cap and restart recovery. The one-minute maximum intentional wait is measured at scheduling decisions. Already-running native stages can affect elapsed time.

### Host-pinned recipes for multiple development repositories

Run `scripts/macos/install-profile-broker.sh OWNER/REPO IMAGE RECIPE` for each managed project. Installing an entry preserves the other projects. The installed configuration pins the image ID at setup. The worker sends an issue, repository and candidate revision. The host chooses the configured recipe and rechecks the approved file scope independently before publishing.

| Recipe | Candidate validation |
| --- | --- |
| `node-strip` | Discover all tracked JavaScript or TypeScript Node tests named `*.test.*` under `tests/` and run them using Node's built-in runner with type stripping. |
| `typescript-build` | Copy the tracked candidate checkout to private temporary container storage, clear existing `dist/`, compile the project with the image's `/opt/jam-bot/node_modules/.bin/tsc -p tsconfig.json`, then run all tracked Node tests under `test/`. Tests may import the fresh build from `dist/`. |

Both recipes require at least one matching test, use the pinned offline toolchain, disable network access, drop capabilities, impose resource limits and mount the candidate read-only. The build profile supports projects that compile with the image's available tooling and dependencies. Image preparation is an operator action. The test run never installs project packages. Check the recipe contract with `node --test test/profile-recipes.test.mjs`.
