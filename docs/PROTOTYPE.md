# Recovery prototype evidence

Scope: [issue #1](https://github.com/alexmakeev/jam-bot/issues/1), guided by [architecture](ARCHITECTURE.md). Requirements remain in [PRD](PRD.md). This is validation evidence, not a second requirements specification.

## Executed locally

Environment: macOS, Node.js 20.15.0, Git, TypeScript 7.0.2, Claude Code 2.1.325. `npm test` compiles strict TypeScript and runs Node's built-in test runner. The five tests passed:

| Check | Actual mechanism and result |
| --- | --- |
| Admission | Local fixture source rejects unapproved cards, reports, changed scope, and dependency-blocked tasks. Local attributed approval is trusted fixture data, not verified GitHub provenance. |
| Supervisor exit and interrupted executor | A CLI supervisor launches a detached real child and exits. A second supervisor finds the same active assignment. SIGKILL then stops that child after its first checkpoint; recovery continues in the same Git worktree. |
| Stale checkpoint and replay | Test intentionally removes completed-step knowledge from the checkpoint. Recovery observes actual worktree artifacts, skips the existing effect, and completes each artifact once. Replayed completed work does not launch again. |
| Concurrent launch and ownership | Two cold starts race for the same exclusive local execution endpoint; one executor runs, attempt count stays one. A conflicting server identity and a returning stale owner epoch are rejected. A fixture owner change is detected before the next effect. |
| Uncertain observation | A listener with the wrong assignment token causes refusal to launch, rather than assuming a worker was lost. |

The local ownership tests simulate two named machines against the same fixture authority. They are **not a test of two physical servers, network partition, or a fenced remote GitHub mutation**. The check-before-write interval is not an atomic distributed fence. Reassignment is not exposed by the prototype. No automatic takeover is safe based on silence alone.

`npm run demo` reproduces launch, active replay, SIGKILL, and recovery, retaining inspectable artifacts in a printed temporary directory. Checkpoints include exact Git HEAD plus observed artifact state; the fixture's working-tree changes remain uncommitted. A HEAD alone therefore does not identify a tested dirty tree. No production build/promotion is claimed.

## Claude evidence kept separate

This chat directly checked the installed CLI and authenticated session, and a tool-free noninteractive call returned `JAM_BOT_HARNESS_OK`. This is a real Claude CLI smoke check, not an Agent Teams test and not the executor used by `npm test`.

The coordinating conversation separately reported an interactive experiment on this Mac with Claude Code 2.1.325: a lead created one in-process teammate, received a checkpoint, and was SIGKILLed. After resume, lookup by name failed, but SendMessage using the saved native agent ID resumed the logical worker from saved history and received another ACK without creating a duplicate. That observation was supplied by the coordinating chat, not reproduced by this fixture. It demonstrates logical-worker restoration, not process survival. The prototype preserves a stable assignment and native fixture handle to keep the distinction visible; no Claude recovery adapter is implemented.

Automatic fallback after lost history, a server/OS restart, unattended question delivery, short-lived subagent delegation, real GitHub integration, and cross-project security remain unverified. A name lookup failure alone must not cause fallback spawning.

## Attachment/API check

The connected GitHub tool inventory was inspected separately: it exposes no operation for uploading a Markdown issue attachment. Browser attachment support does not establish an App/API upload path. No speculative endpoint was called and no repository link was substituted for an attached original/fix spec. Automatic .md attachment delivery remains blocked under Q-07, pending a tested mechanism. The architecture and this report are repository design/evidence documents, not substitutes for required issue attachments.

## Operational limits

- Only trusted local fixture input, one host, and file-based operational records. Runtime config and secrets are not published.
- The loopback token checks assignment identity, not a security boundary against a hostile local user. Port collisions fail closed.
- No power-loss transaction guarantee, arbitrary exactly-once side effects, or cross-machine takeover guarantee. The fixture effects are deliberately inspectable; external uncertain effects still require reconciliation.
- No production service, webhook deployment, real task creation, shared branch promotion, stable build approval, consultant integration, or model-quality claim.
