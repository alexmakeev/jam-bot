# Leo Developer work profile

A trusted maintainer creates and locks a self-contained English work card. The GitHub App verifies the lock, immutable author identity, current repository role and approved scope. The local test installation supports personal repositories. Labels show progress; authorization comes from the work card and the live access check.

## Work cards

The body starts with `I approve this Leo Developer work card.`, a blank line, a `Class: assignment`, `Class: consultation` or `Class: development` line, and a `Files: ...` line. A blank line separates those fields from the task. List editable repository-relative files separated by a comma and a space. Use `Files: none` for a direct assignment or consultation.

| Class | Work and completion |
| --- | --- |
| Assignment | A named teammate carries out the request and returns its deliverable to Leo. The service posts the result and closes the issue. |
| Consultation | A named consultant answers the approved question. The issue closes with the recommendation. |
| Development | The architect prepares a specification. The developer receives the scope and accepted specification, edits the authorized files in a separate worktree, and submits a tested revision for review. Leo groups ready revisions for the integrator. The service closes the cards after the tested candidate reaches dev. |

The labels `kind:task`, `approval:approved` and `class:<class>` persist. The active phase appears as one of `status:queued`, `status:planning`, `status:in-progress`, `status:in-validation` or `status:blocked`. The provider's closed state records completion. See [PRD JB-20](PRD.md) for the batching policy.

## Specification handoff on GitHub

An architect's Markdown specification is written to the topic's `assignments/<issue>/attachments` directory. GitHub's web form can upload that file as an attachment in a comment on the originating issue. The verified operator handoff records the full SHA-256 of the downloaded attachment, the comment ID, and its GitHub attachment URL in a sibling file named `<filename>.receipt.json`. The service checks the digest against the original specification, the repository owner's comment identity, the issue and the attachment reference before developer dispatch. Until the receipt arrives, the local wait consumes no model calls. This step currently requires an operator with access to the private issue. [GitHub attachments](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) · [GitHub CLI attachment limits](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli#limitations)

## Acceptance environment

The test profile targets TypeScript using the Node test runner. The publisher reads a private repository on the machine and shares a Git bundle with the local service. A separate container executes the candidate tests with networking disabled and the candidate checkout mounted read-only. The publisher checks the remote base before updating the test repository's dev branch. Each native role sends its result to the repository coordinator. The local role receipts retain the team identity and the matching mailbox exchange.

## Verified run

The [assignment](https://github.com/alexmakeev/jam-bot-test/issues/10) and [consultation](https://github.com/alexmakeev/jam-bot-sandbox/issues/3) closed with their respective teammate outputs. The [development issue](https://github.com/alexmakeev/jam-bot-sandbox/issues/4) recorded planning, active work, waiting for integration, validation, a blocked review, resumed validation and closure. The architect's specification was attached through GitHub's web form. The operator verified its bytes and recorded the receipt. The integrator initially rejected the test evidence. After the runner supplied a fuller report, the operator retried the same revision. Eight candidate tests passed. The [verified revision](https://github.com/alexmakeev/jam-bot-sandbox/commit/d90b1aa26aa344c2bbc1539932eb8fc672857ab0) reached dev and the clean feature worktree and branch were removed.

The live integration contained one ready task. The scheduler tests cover larger batches, including sixteen readying branches processed as ten followed by six, the fifteen-branch cap and restart recovery. The one-minute maximum intentional wait is measured at scheduling decisions. Already-running native stages can affect elapsed time.
