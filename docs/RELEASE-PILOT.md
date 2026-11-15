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

Reload the management environment host with this version of `environment-host.mjs`. Define both environments through the authenticated management client, with the corresponding loopback endpoint and an empty list of secret references. Create the private file `~/.jam-bot/management/calculator-release-pilot/config.json` with `{"acceptanceMinutes":5,"automatic":true}`. Five minutes was chosen for the local demonstration. The operator chooses the project's acceptance period. Install the dedicated login service using `scripts/macos/install-release-pilot.sh /absolute/path/to/node` with Node 22.13 or later, an authenticated GitHub CLI, Git and Docker.

## Release and recovery

The local service examines the host's durable development receipts every 30 seconds. It holds one RC until stable acceptance. The development branch can advance throughout that window. On a new qualifying deployment it checks the recorded SHA on development, runs the complete trusted unit and browser recipe on a detached copy, and deploys the verified image in isolated staging. Live browser assertions compare the served HTML to the accepted candidate. One atomic Git push fast-forwards main and creates the nightly tag under expected-reference checks. The host publishes a GitHub prerelease, deploys the identical image to the local production-like instance, and repeats the live checks there. An archived result and its English Markdown report are delivered to the original issue.

The host stores the acceptance window, immutable image, baselines, reports and publication receipts under `~/.jam-bot/management/calculator-release-pilot/`. Its SQLite lock serializes promotion. A failed browser gate restores the previous healthy instance if available. A failed first deployment is stopped. Resume a specific recorded RC with `node scripts/macos/release-pilot.mjs rc FULL_SHA`. A moved baseline or conflicting release tag requires operator reconciliation.

After testing the local pilot, the owner or an authorized organization maintainer posts this exact sentence as a fresh comment on the original issue, substituting the complete lowercase SHA.

```text
Approve JAM-Bot stable release of alexmakeev/jam-bot-test at FULL_SHA.
```

The signed issue-comment webhook records a wake-up for the host. The host independently reads the original comment from GitHub, checks its authorship, repository permissions, approval time and exact commit, and tests the current local pilot again. It then creates the stable tag and release and sends the verification report to the same task. To recover a missed notification, run `node scripts/macos/release-pilot.mjs stable FULL_SHA COMMENT_ID` using the numeric ID from the comment link. The RC and stable stages both record the published revision. This pilot deploys exclusively to the two loopback environments described above.
