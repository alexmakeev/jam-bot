# Test calculator development site

The host operator can opt in the private Test repository to publish its local calculator after integration into `dev`. Its site listens on `127.0.0.1:19853`. The publisher checks GitHub repository ID `1457276291` before deployment.

1. Install the regular development publisher and management environment host. Configure the `calculator` development environment with its loopback endpoint and empty secret list. Verify the operator's management CLI can route to `alexmakeev/jam-bot-test`.
2. In the host's private environment catalog, set `autoDeployCalculator: true` on that exact recipe. Reload the environment host.
3. In the private Test publisher entry, set `autoDeployCalculator: true`, `managementNode` to a Node executable supporting the management CLI, and `calculatorRuntimeImage` to a full local image ID containing Node and the calculator health check. The existing `image` field pins the isolated compiler.

The publisher records a local intent before pushing the validated candidate. After verifying the remote development head, it reads the regular Git blobs for `web/index.html`, `web/server.mjs`, and `src/triangular.ts`. A fixed network-isolated compiler produces the browser module. A host-owned Dockerfile packages these three files. Repository scripts and credentials are outside the build context. Adding another entry point or asset requires updating this project recipe.

The authenticated management deployment verifies the exact running revision, image, health and port. Its existing rollback retains the previous healthy release. The publisher retries failed jobs independently of Git publication and skips superseded revisions. Per-SHA receipts are in the host operator's private `.jam-bot/management/calculator-dev-queue/` directory. Only this development recipe reads the local release index.

### Sandbox sum page

The private Sandbox repository (ID `1457276329`) has a separate development environment, `sum`, on `127.0.0.1:19854`. Its host recipe uses `autoDeploySum: true`, with `sum-dev-releases.json` and `sum-dev-queue/` in the management directory. Its publisher entry uses the same pinned compiler and runtime image settings as Test, plus its own `autoDeploySum: true`. The recipe compiles `src/sum.ts` to `sum.js`, packages the regular blobs `web/index.html` and `web/server.mjs`, and verifies the published SHA and actual container health. The ordinary Sandbox validation recipe remains `node-strip`.

Build the trusted browser image from `scripts/calculator-smoke/`, pin its ID as `sumBrowserImage` and set `runningTotalsCard` to the approved cumulative-sums issue number. Every candidate exercises the sum form with keyboard input at 320 and 1280 pixels. The selected card also verifies the ordered intermediate totals for mixed input and clearing the previous result after an empty submission.

Set the optional `clearTotalsCard` in the same Sandbox entry to verify the secondary Russian clear action for that approved card. The check retains the cumulative sum assertions, clicks the control after a calculation and activates it again by keyboard on an empty list. It verifies cleared input, zero total, cleared cumulative values and restored keyboard focus.

Sandbox browser checks start the reviewed `web/server.mjs` in the offline container and fetch its actual page and compiled module over loopback HTTP. The pinned server digest belongs to the host recipe. A server change requires a reviewed digest update. The report records the server and browser versions, HTTP result, JavaScript MIME and isolated URL. The accepted list must have a computed accessible name, retain focus on submit, preserve separate rows for long numeric values, and clear stale values after invalid or blank input. A 640 CSS-pixel viewport at device scale factor 2 supplements the mobile and desktop checks.
