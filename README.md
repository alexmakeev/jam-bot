# JAM-Bot

MIT-licensed project in active design. See [PRD](docs/PRD.md), [architecture](docs/ARCHITECTURE.md), and [glossary](docs/GLOSSARY.md). This repository currently contains a local TypeScript/Node.js recovery experiment for [issue #1](https://github.com/alexmakeev/jam-bot/issues/1), **not the production MVP**.

## Run the experiment

Requires Node.js 20+ and Git. No runtime packages, GitHub credentials, or paid model calls are used by the fixture.

```sh
npm ci
npm test
npm run demo
```

Tests create disposable Git repositories and worktrees. The demo keeps its temporary directory and prints the location, launch/replay/recovery outcomes, checkpoint, and actual artifacts. It interrupts only its own test worker. It never starts a public server, modifies a remote repository, or promotes branches.

For a prepared local fixture, use `node dist/src/cli.js CONFIG.json CARD_ID`. Configuration contains `root`, `repo`, `server`, `approvers`, and optional `stepDelayMs`. The fixture source reads `cards/<hash>.json` and `owners/<hash>.json` under root. `src/demo.ts` is the complete runnable example; do not treat user-supplied fixture JSON as authenticated approval.

For a separate operator-approved run using a real GitHub issue and a paid Claude Code session, see the [live recovery experiment](docs/PROTOTYPE.md#operator-run-live-experiment).

## What exists

- Typed source/card/assignment/checkpoint boundaries; English card with human actor, conversation reference, and exact approved scope.
- Admission checks for task kind, configured approver, scope, and unresolved dependencies.
- One stable assignment/native fixture handle, real feature branch/worktree, and a controllable child-process executor.
- Atomic-renamed local checkpoints, actual artifact reconciliation, replay, and restart without reapplying already observed effects.
- Exclusive OS loopback listener per assignment, checked by assignment token instead of PID alone. An uncertain or conflicting listener blocks launch. Two cold launch requests may create two runner processes; only the one that owns the listener becomes an executor. The loser exits without executing.
- Explicit owner/epoch checks and diagnostics. These are fixture guards, not distributed fencing.

The compact file journal avoids a database dependency for the experiment. It is not the remote business source of truth and does not claim power-loss durability (there is no fsync transaction protocol). SQLite remains a product-design candidate.

## Boundaries and evidence

See [prototype validation](docs/PROTOTYPE.md) for executed checks and limitations. The fixture adapter trusts local test data; it does not verify GitHub approval or signatures. It has no REST/OpenAPI service, remote management MCP, webhook receiver, upload API, real Claude team adapter, sandbox, or cross-host fencing. Do not expose it or use it for untrusted work.
