# Development quality gate runtime

This runtime note describes the concrete implementation of PRD JB-45. The requirement remains in the PRD.

Both trusted recipes invoke `static-quality.mjs` before running unit tests. The helper is mounted read-only from the broker installation, independently of the candidate repository. It emits a `development-static-v1` receipt with the candidate revision and separate toolchain, generated-code-comment, lint, format and type outcomes. Failed and unavailable checks prevent unit execution and implementation consultation eligibility. The broker retains these receipts when shortening test output.

## Trusted image contract

The image must supply these exact packages under `/opt/jam-bot/node_modules`, with a usable `/opt/jam-bot/package.json`:

| Tool | Version | Purpose |
| --- | --- | --- |
| TypeScript | 7.0.2 | Semantic compiler checks |
| `@biomejs/biome` | 2.3.8 | Fixed lint and formatting checks |
| `@babel/parser` | 7.28.5 | JavaScript and TypeScript comment tokens |
| `@types/node` | 22.20.5 | Explicit trusted Node declarations |
| `parse5` | 7.2.1 | HTML comment and embedded-language boundaries |
| `postcss` | 8.5.6 | CSS comment tokens |

The candidate image built with `scripts/consultants/Dockerfile.quality` supplies these tools. A real container probe completed baseline GREEN, assertion-only RED and implementation GREEN. Live broker installation remains a separate acceptance step. Images containing only the earlier compiler fail with unavailable outcomes; they cannot claim the stronger gate passed. Package versions are checked inside the selected trusted image, whose immutable digest should be retained in the execution evidence.

Biome receives a generated fixed configuration outside the repository, with recommended lint rules, default formatting and assists disabled. Repository formatter/linter configuration, plugins, package scripts and automatic fixes are not invoked. Unsupported files produce diagnostics rather than silently claiming coverage.

`typescript-build` checks the repository's declarative `tsconfig.json` with no emission and incremental compilation disabled, then retains its existing build-and-test procedure. `node-strip` additionally checks tracked JavaScript and TypeScript using fixed strict, check-JavaScript, no-emit, ES2022 and NodeNext options. Native Node type stripping alone is not semantic checking. The concrete project/image must provide the declarations and dependencies needed by its selected type-check recipe; missing declarations block the gate. These fixed choices may expose existing baseline lint, formatting or typing defects, which require explicit correction before development can begin.

## Generated comments

For changed tracked JavaScript and TypeScript files, compare parser comment tokens with the same file in baseline production. Unchanged existing comment tokens remain allowed; new tokens and additional copies fail. Strings, template contents and regular expressions are interpreted by the parser rather than searched using a comment-like-text regular expression. Syntax errors fail validation. HTML uses parse5 comment nodes plus Babel for embedded JavaScript and PostCSS for embedded styles; standalone CSS uses PostCSS. Strings containing comment-like text are not comments. New or changed SCSS, Vue and Svelte code explicitly reports unavailable comment parsing and blocks until its concrete language parser is supported. No claim of comment coverage is made for other languages.

## Verification and limits

Focused tests use injected trusted-tool metadata, parser output and command runners. They verify check selection, exact compiler arguments, fail-closed missing tools, individual check failures, unsupported comment languages, baseline-token preservation and receipt identity. Real container probes additionally verified the HTML, embedded JavaScript and CSS parsers, the trusted toolchain, and a complete RED/GREEN cycle. The candidate Test/Sandbox baselines have also passed the stronger static checks and unit suites; publication and live autonomous acceptance remain separate steps.

Static failures never establish RED because the unit runner is reached only after all static checks pass. The trusted `unit-reporter.mjs` consumes Node test events and emits a compact `unit-assertions-v1` receipt. RED requires at least one leaf failure and every leaf failure to carry `ERR_ASSERTION`; import, hook, timeout and cancellation failures reject mixed runs. Suite aggregate failures are recorded separately. Raw test stdout and stderr events are not treated as receipts. Reporter retention is bounded; overflow marks the receipt incomplete and disqualifies RED. A passing static receipt alone does not classify a failing unit run. The developer must require the structured unit receipt alongside the static receipt and exact revision when accepting initial or refined RED evidence.

## Controlled rollout

The host project entry enables this gate explicitly with `qualityGate: "development-static-v1"` and its pinned quality image. The Development service separately enables independent reading, evidence validation and Cleaner only for repositories listed in the operator setting `JAM_DEVELOPMENT_V2_REPOSITORIES`. The default is empty. This temporary rollout boundary keeps unrelated installed topics on their existing recipe; it is not the future profile-plugin interface from JB-27.
