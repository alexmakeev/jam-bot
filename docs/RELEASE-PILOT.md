# Test calculator release pilot

The host runs the JB-14 pilot for `alexmakeev/jam-bot-test`. A qualifying development deployment receipt binds the original issues, Git commit, Docker image and actual development-site browser checks. The current recipe supports the static SVG calculator acceptance suite. A new product or acceptance suite requires its own reviewed recipe.

## Host setup

Use the existing management host, private publisher configuration and GitHub operator login. Check that loopback ports 19857 and 19858 are free. In the host-private management catalog register two exact staging recipes for repository ID 1457276291. Use the following entry for staging, then add a second entry with environment `calculator-pilot` and port 19858.

```json
{
  "repoId": 1457276291,
  "environment": "calculator-rc",
  "tier": "staging",
  "releases": {},
  "containerPort": 8080,
  "loopbackPorts": [19857],
  "allowBridgeEgress": true,
  "localReleasePilot": true
}
```

Reload the management environment host with this version of `environment-host.mjs`. Define both environments through the authenticated management client, with the corresponding loopback endpoint and an empty list of secret references. Create the private file `~/.jam-bot/management/calculator-release-pilot/config.json` with `{"automatic":true}`. The project selects its acceptance period in the release table and the operator can enforce a minimum. Install the dedicated login service using `scripts/macos/install-release-pilot.sh /absolute/path/to/node` with Node 22.13 or later, an authenticated GitHub CLI, Git and Docker.

## Repository routing

The publisher and release host select the same operator-registered profile ref under the publisher project entry's `releaseProfile.profileRef`. Both local pilots use `jam-bot-profile`. This keeps profile changes independent of the build under acceptance. The host resolves the GitHub repository ID and profile ref, then reads `.jam-bot/VALUES.md` by the resulting commit SHA. Receipts include both the profile commit and the deployed commit.

The compact Markdown section in the calculator repository is:

```markdown
## Release routes

| Source | Channel | Destination | Trigger | Checks | Acceptance |
| --- | --- | --- | --- | --- | --- |
| branch:dev | nightly | calculator-rc | checks | unit, browser, live | 0m |
| channel:nightly | rc | calculator-pilot | checks | unit, browser, live | 5m |
| channel:rc | stable | none | approval | unit, browser, live | 0m |
```

`Source` names a Git branch or the output channel of an earlier row. `Channel` identifies the tested build. `Destination` names a separately registered deployment environment. `none` is valid for the stable maturity decision. The trigger accepts successful checks, a UTC schedule such as `daily@12:00Z`, or an exact human approval. `Acceptance` specifies how long this output must be held before its next transition. Stable requires a human comment for the exact SHA even after this period elapses.

The second installed repository uses the same header and one row:

```markdown
| branch:dev | nightly | sum-nightly | daily@12:00Z | unit, browser, live | 0m |
```

The Sandbox recipe uses the newest green source available for the daily UTC slot. It verifies the source branch head again before deploying. Build checks run against a detached copy, Chromium exercises its candidate page and the live browser submits sample input at the configured development site. Its durable receipt under `~/.jam-bot/management/release-routes/1457276329/<sha>.json` contains the test report, image, exact destination and live result. The two recipes advance independently.

Machine policy grants each repository concrete capabilities. For example, the Sandbox publisher entry includes:

```json
{
  "releaseProfile": {
    "recipe": "sum-nightly",
    "repoId": 1457276329,
    "profileRef": "jam-bot-profile",
    "channels": {
      "nightly": {
        "sources": ["branch:dev"],
        "triggers": ["daily"],
        "destinations": ["sum-nightly"],
        "requiredChecks": ["unit", "browser", "live"]
      }
    },
    "environments": {"sum-nightly": {"tier": "development", "port": 19860}}
  }
}
```

Register `sum-nightly` in the host-private catalog with that repository ID, tier `development`, `containerPort: 8080`, `loopbackPorts: [19860]`, `allowBridgeEgress: true`, `releases: {}` and `repositoryRelease: true`. Save the matching environment in management. The host reads an immutable-image index scoped to the repository ID. Repository guidance cannot select keys, host mounts, commands, foreign projects or unregistered destinations.

For Test, register `recipe: "calculator-rc"`, the corresponding repository ID, the shared profile ref and `promotionBranch: "main"`. Grant each channel only the sources, trigger classes, named destinations and required checks in its table. For the `rc` channel set `minimumMinutes: 5` in this installation. The destinations map binds the two staging environments to their respective ports. For an operator-registered alternate Test destination, use a `repositoryRelease: true` host recipe for the same repository. A held candidate records its route; a changed route requires reconciliation before release.

## Release and recovery

The local service examines the host's durable development receipts every 30 seconds. It holds one RC until stable acceptance. The development branch can advance throughout that window. On a new qualifying deployment it checks the recorded SHA on development, runs the complete trusted unit and browser recipe on a detached copy, and deploys the verified image in isolated staging. Live browser assertions compare the served HTML to the accepted candidate. One atomic Git push fast-forwards main and creates the nightly tag under expected-reference checks. The host publishes a GitHub prerelease, deploys the identical image to the local production-like instance, and repeats the live checks there. An archived result and its English Markdown report are delivered to the original issue.

The host stores the acceptance window, immutable image, baselines, reports and publication receipts under `~/.jam-bot/management/calculator-release-pilot/`. Its SQLite lock serializes promotion. A failed browser gate restores the previous healthy instance if available. A failed first deployment is stopped. Resume a specific recorded RC with `node scripts/macos/release-pilot.mjs rc FULL_SHA`. A moved baseline or conflicting release tag requires operator reconciliation.

After testing the local pilot, the owner or an authorized organization maintainer posts this exact sentence as a fresh comment on the original issue, substituting the complete lowercase SHA.

```text
Approve JAM-Bot stable release of alexmakeev/jam-bot-test at FULL_SHA.
```

The signed issue-comment webhook records a wake-up for the host. The host independently reads the original comment from GitHub, checks its authorship, repository permissions, approval time and exact commit, and tests the current local pilot again. It then creates the stable tag and release and sends the verification report to the same task. To recover a missed notification, run `node scripts/macos/release-pilot.mjs stable FULL_SHA COMMENT_ID` using the numeric ID from the comment link. The RC and stable stages both record the published revision. This pilot deploys exclusively to the two loopback environments described above.
