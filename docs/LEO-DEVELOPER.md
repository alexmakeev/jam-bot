# Leo Developer work profile

Create an open issue with native type **Task**, or assign that type to a finished draft. The service checks the signed actor's current repository write access and locks the conversation. A draft without the Task type can be edited before approval.

## Work cards

Use the title and description to explain the work. The repository's Leo Developer profile defaults to development. List the approved editable paths in a leading `Files: src/example.ts, tests/example.test.ts` line before the task description. An explicit `Class: assignment` or `Class: consultation` line can select another route. Ordinary tasks require no class label or approval phrase.

| Class | Work and completion |
| --- | --- |
| Assignment | A named teammate carries out the request and returns its deliverable to Leo. The service posts the result and closes the issue. |
| Consultation | A named consultant answers the approved question. The issue closes with the recommendation. |
| Development | The architect prepares a specification. The developer receives the scope and accepted specification, edits the authorized files in a separate worktree, and submits a tested revision for review. Leo groups ready revisions for the integrator. The service closes the cards after the tested candidate reaches dev. |

The native Task type and local approval record identify the work. The service adds only the current phase label. The active phase appears as one of `status:queued`, `status:planning`, `status:in-progress`, `status:in-validation` or `status:blocked`. The provider's closed state records completion. See [PRD JB-20](PRD.md) for the batching policy.

## Specification handoff on GitHub

Run `npm ci && npm run build` on the operator Mac and build the matching receiver image. Invoke `node scripts/macos/attach-spec.mjs OWNER/REPOSITORY ISSUE` for a development card in planning. The helper opens a dedicated Chrome profile. Sign in to GitHub there if needed. Keep the comment editor empty. Use this helper for the production handoff; using the system file chooser bypasses the pre-upload check.

Before supplying any bytes to GitHub, the helper verifies the destination and obtains the exact Markdown bytes from the receiver. The receiver compares the staged artifact with the architect's original output for that issue. The browser receives one in-memory file with a derived name. Before posting, the helper checks that the draft contains exactly its attachment link, downloads the upload, compares all bytes, rechecks the specification, and posts the fixed link using the owner's GitHub CLI identity. On receipt, the worker gate reads the published comment and requires the exact attachment link and original author and issue. The developer receives the original verified specification. An unexpected draft or byte mismatch interrupts the handoff. A browser or API error after selection may leave an unpublished uploaded asset. The service waits locally for the receipt. The historical run below used the earlier manual upload procedure. [GitHub attachments](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)

## Acceptance environment

The test profile targets TypeScript using the Node test runner. The publisher reads a private repository on the machine and shares a Git bundle with the local service. A separate container executes the candidate tests with networking disabled and the candidate checkout mounted read-only. The publisher checks the remote base before updating the test repository's dev branch. Each native role sends its result to the repository coordinator. The local role receipts retain the team identity and the matching mailbox exchange.

## Verified run

The [assignment](https://github.com/alexmakeev/jam-bot-test/issues/10) and [consultation](https://github.com/alexmakeev/jam-bot-sandbox/issues/3) closed with their respective teammate outputs. The [development issue](https://github.com/alexmakeev/jam-bot-sandbox/issues/4) recorded planning, active work, waiting for integration, validation, a blocked review, resumed validation and closure. The architect's specification was attached through GitHub's web form. The operator verified its bytes and recorded the receipt. The integrator initially rejected the test evidence. After the runner supplied a fuller report, the operator retried the same revision. Eight candidate tests passed. The [verified revision](https://github.com/alexmakeev/jam-bot-sandbox/commit/d90b1aa26aa344c2bbc1539932eb8fc672857ab0) reached dev and the clean feature worktree and branch were removed.

The live integration contained one ready task. The scheduler tests cover larger batches, including sixteen readying branches processed as ten followed by six, the fifteen-branch cap and restart recovery. The one-minute maximum intentional wait is measured at scheduling decisions. Already-running native stages can affect elapsed time.
