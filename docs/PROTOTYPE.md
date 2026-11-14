# Recovery prototype evidence

Scope: [issue #1](https://github.com/alexmakeev/jam-bot/issues/1), guided by [architecture](ARCHITECTURE.md). Requirements remain in [PRD](PRD.md). This is validation evidence, not a second requirements specification.

## Executed locally

Environment: macOS, Node.js 20.15.0, Git, TypeScript 7.0.2, Claude Code 2.1.325. `npm test` compiles strict TypeScript and runs Node's built-in test runner. The five tests passed:

| Check | Actual mechanism and result |
| --- | --- |
| Admission | Local fixture source rejects unapproved cards, reports, changed scope, and dependency-blocked tasks. Local attributed approval is trusted fixture data, not verified GitHub provenance. |
| Supervisor exit and interrupted executor | A CLI supervisor launches a detached real child and exits. A second supervisor finds the same active assignment. SIGKILL then stops that child after its first checkpoint; recovery continues in the same Git worktree. |
| Stale checkpoint and replay | Test intentionally removes completed-step knowledge from the checkpoint. Recovery observes actual worktree artifacts, skips the existing effect, and completes each artifact once. Replayed completed work does not launch again. |
| Concurrent launch and ownership | Two concurrent launches with a prepared assignment and worktree race for the same exclusive local execution endpoint; one executor runs, attempt count stays one. A conflicting server identity and a returning stale owner epoch are rejected. A fixture owner change is detected before the next effect. |
| Uncertain observation | A listener with the wrong assignment token causes refusal to launch, rather than assuming a worker was lost. |

The local ownership tests simulate two named machines against the same fixture authority. They are **not a test of two physical servers, network partition, or a fenced remote GitHub mutation**. The check-before-write interval is not an atomic distributed fence. Reassignment is not exposed by the prototype. No automatic takeover is safe based on silence alone.

`npm run demo` reproduces launch, active replay, SIGKILL, and recovery, retaining inspectable artifacts in a printed temporary directory. Checkpoints include exact Git HEAD plus observed artifact state; the fixture's working-tree changes remain uncommitted. A HEAD alone therefore does not identify a tested dirty tree. No production build/promotion is claimed.

## Claude evidence kept separate

This chat directly checked the installed CLI and authenticated session, and a tool-free noninteractive call returned `JAM_BOT_HARNESS_OK`. This is a real Claude CLI smoke check, not an Agent Teams test and not the executor used by `npm test`.

The coordinating conversation separately reported an interactive experiment on this Mac with Claude Code 2.1.325: a lead created one in-process teammate, received a checkpoint, and was SIGKILLed. After resume, lookup by name failed, but SendMessage using the saved native agent ID resumed the logical worker from saved history and received another ACK without creating a duplicate. That observation was supplied by the coordinating chat, not reproduced by this fixture. It demonstrates logical-worker restoration, not process survival. The prototype preserves a stable assignment and native fixture handle to keep the distinction visible; the fixture uses its own child-process harness.

Automatic fallback after lost history, a server/OS restart, unattended question delivery, short-lived subagent delegation, webhook delivery, production GitHub approval verification, and cross-project security remain unverified. A name lookup failure alone must not cause fallback spawning.

## Attachment/API check

The connected GitHub tool inventory was inspected separately: it exposes no operation for uploading a Markdown issue attachment. Browser attachment support does not establish an App/API upload path. No speculative endpoint was called and no repository link was substituted for an attached original/fix spec. Automatic .md attachment delivery remains blocked under Q-07, pending a tested mechanism. The architecture and this report are repository design/evidence documents, not substitutes for required issue attachments.

## Operational limits

- Only trusted local fixture input, one host, and file-based operational records. Runtime config and secrets are not published.
- The loopback token checks assignment identity, not a security boundary against a hostile local user. Port collisions fail closed.
- No power-loss transaction guarantee, arbitrary exactly-once side effects, or cross-machine takeover guarantee. The fixture effects are deliberately inspectable; external uncertain effects still require reconciliation.
- No production service, webhook deployment, real task creation, shared branch promotion, stable build approval, consultant integration, or model-quality claim.


## Operator-run live experiment

Build with `npm run build`. In a terminal at the repository root, run
`node dist/src/live-recovery.js LOCKED_OPEN_ISSUE_URL --approve-experiment`.
This separate experiment uses the authenticated GitHub CLI and consumes Claude Code quota. It reads the specified open issue twice, checks its scope for changes, and operates in a temporary clone of the current checkout's committed HEAD. The operator approves a synthetic checkpoint exercise for that issue. It does not implement the actual feature described in the issue or write to GitHub.

The lead starts one developer. The observer requires a checkpoint file, a matching native worker write and a delivered acknowledgment before killing the lead. It saves the native agent handle, restarts the same lead session and checks the second checkpoint and acknowledgment from the same developer, with one spawn across the trace. A missing acknowledgment, unexpected trace format or extra spawn cannot produce a passing result. Trace inspection is acceptance instrumentation specific to Claude Code 2.1.325. It should stay out of the production protocol. Temporary evidence remains in the printed directory.

The independent Opus review prompted these identity checks, clarification of the prepared-worktree concurrency test, and a design distinction between ownership of a live lead process and resumption of a logical teammate. Concurrent recovery of the same live Claude session, true first-time assignment races, and replacement after loss of native session history remain separate tests.

Verified on the development Mac with the open architecture and recovery issue: the strengthened live runner exited successfully. The native trace contained one developer spawn and writes and acknowledgments for both distinct checkpoint tokens under the same native handle across the forced lead restart. The five fixture tests and the interruption demo also passed on this source revision.

The operator-run live experiment attributes its explicit approval to the authenticated GitHub CLI user, saves the numeric user ID, and queries current repository permissions before initial preparation and each Claude start/resume. Personal repositories require the owner; organization repositories require maintain/admin. API failures stop admission. GitHub CLI identifies the approving operator. Current role and card-lock reads use fresh repository-scoped GitHub App installation tokens with Metadata read and Issues read. Configure JAM_GITHUB_APP_ID, JAM_INSTALLATION_ID and JAM_GITHUB_APP_KEY_FILE. Missing App configuration fails admission. The key stays in private local storage; tokens are held in memory. Fixture authorization accepts only fixture project URIs.

For a webhook-to-worker acceptance run, create and lock the approved experiment issue in the installed test repository. Set JAM_E2E_RECEIVER to the local service container name before running the live experiment. The runner verifies the receiver's repository, waits for the matching acknowledged delivery, and records its ID with the assignment. It clones the issue's repository and starts the test developer locally. On the development Mac the signed delivery for test issue 7 reached Leo through the AM32 tunnel. The same developer wrote and acknowledged both checkpoints across the forced lead restart. Launching this acceptance runner is an operator step; the service itself handles intake only.
