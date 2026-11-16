# Local deployment runner

The Mac installs a per-user LaunchAgent with a private catalog in `~/.jam-bot/management/catalog.json`. A new catalog starts with an empty recipe list. The Docker socket stays on the host. An empty repository list permits authenticated management before the first project is connected.

## Owner access

The installer generates the server UUID and a 256-bit owner bearer in `~/.jam-bot/management/owner.token`. The file and catalog are mode 0600 under a mode 0700 directory. Supply this token to a client using its private credential file. The receiver receives its SHA-256 verifier. An authenticated management request keeps its bearer in a request-scoped memory context while the host action runs. Webhook and teammate paths cannot sign host actions.

`JAM_MANAGEMENT_HOSTS` lists allowed HTTP Host authorities. The public HTTPS reverse proxy must preserve Host and Authorization and permit the `/mcp` and `/api/v1/` routes. Configure proxy read timeouts for the deployment deadline. To rotate the bearer, stop accepting management operations, drain active requests, replace the token with a fresh 32-byte random hex string, rerun the host installer and recreate the receiver to reload the verifier. The server identity and existing state persist.

## Recipes

Register either an exact `environment` or an `environmentPrefix` such as `preview-` under a repository ID. An exact match takes precedence. Ambiguous matching prefixes fail closed. Each matching instance gets its own project, runtime state and data. Loopback ports remain reserved for their configured instance across a stop. The host pins `tier`, specific release revisions in `releases` mapped to installed Docker `sha256:` image IDs, and optional application variable names in `appVariables`. The remote interface accepts standard log levels and public `APP_*` variables. A stable recipe also needs the exact release in `stableApprovedRevisions` alongside the separately verified GitHub approval. Restart the host LaunchAgent after editing the catalog.

Use `dataPath: "/data"` or a single child path under `/data` to give the application a named data volume. Prepare that path for UID 65532 in the image. Each server/repository/environment derives its own project and data volume. Stop and redeploy preserve the volume. Operator-approved secret aliases in `secrets` map to dedicated private files on the host. The host prepares copies readable by the unprivileged container process inside a private runtime directory. Secret values remain outside API requests and results. Redeploying the same revision reloads a changed secret file. The host keeps the prior snapshot through validation so that a failed update can restore the previous binding.

The default service uses network mode `none`. To publish an endpoint register an exact `containerPort`, a list of allowed `loopbackPorts`, and explicitly set `allowBridgeEgress: true`. Published services bind only to 127.0.0.1 and use a distinct bridge per project. On Docker Desktop these project bridges permit outbound traffic. The host checks the effective Docker binding, establishes a local TCP connection and verifies the image health check. Recipes require an immutable image with a working health check and no declared anonymous volumes. The generated service has a read-only root filesystem, fixed non-root user, reduced capabilities, bounded resources, and a small writable temporary directory.

### Register preview instances

With the runner installed and a health-checked local image available, set the repository ID and image tag for the project. This example prepares a staging prefix with two approved loopback ports and one writable volume. The image must listen on port 8080, support UID 65532, and prepare `/data` with suitable ownership. The sample uses the full local image digest as its immutable revision.

```sh
export JAM_EXAMPLE_REPO=123456
export JAM_EXAMPLE_IMAGE=my-app:tested
node --input-type=module <<'JS'
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const path = process.env.HOME + '/.jam-bot/management/catalog.json';
const catalog = JSON.parse(readFileSync(path, 'utf8'));
const repoId = Number(process.env.JAM_EXAMPLE_REPO);
if (!Number.isSafeInteger(repoId) || repoId <= 0) throw Error('Invalid repository ID');
const image = execFileSync('docker', ['image', 'inspect', process.env.JAM_EXAMPLE_IMAGE,
  '--format', '{{.Id}}'], {encoding:'utf8'}).trim();
if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw Error('Expected an immutable local image');
const recipe = {repoId, environmentPrefix:'preview-', tier:'staging',
  releases:{[image.slice(7)]:image}, dataPath:'/data',
  appVariables:['APP_MODE'], allowBridgeEgress:true, containerPort:8080, loopbackPorts:[19850,19851]};
if (catalog.recipes.some(r => r.repoId===repoId && r.environmentPrefix==='preview-')) {
  throw Error('Review the existing preview recipe before replacing its registered releases');
}
catalog.recipes.push(recipe);
writeFileSync(path+'.new', JSON.stringify(catalog,null,2), {mode:0o600,flag:'wx'});
renameSync(path+'.new',path);
console.log('Release revision', image.slice(7));
JS
launchctl kickstart -k "gui/$(id -u)/local.jam-bot.environment-host"
```

A maintainer can then create `preview-pr-71` and `preview-pr-72` through authenticated management using the staging tier, a different approved port for each, and the printed revision. Future instance names with this prefix require no individual host recipe.

## Delivery and recovery

The receiver submits `deploy`, `status` or `stop` through a dedicated local exchange. Every request contains the server UUID, repository ID, environment, action, request UUID, timestamp and applicable configuration. An HMAC-SHA256 covers the complete serialized UTF-8 request with a versioned domain prefix. Responses use a separate signing domain. The host rejects invalid signatures, unknown fields, mismatched server identities, path inputs outside its catalog and clock skew exceeding two minutes. A persistent SQLite ledger binds each accepted ID to its exact payload digest. It records the intent before contacting Docker. Duplicate requests retrieve the saved outcome. An exclusive kernel lock serializes the host process.

The runner reconciles journaled operations on startup, including a recorded rollback phase. Before updating its known-good record it checks the observed image, ownership, published endpoint and consecutive health observations. A failed update restores the previously registered image when possible. If there is no known-good release, it stops the failed service. Project labels, a private project ownership value, a stored container identity and the current deployment generation constrain reconciliation. Docker administrators are within the host trust boundary. A conflicting resource requires operator inspection.

Install with `scripts/macos/install-environment-host.sh` or the main Mac service installer. The host needs Node with `node:sqlite`, Docker Compose, and permission to run Docker. `JAM_HOST_NODE` can select the executable. Restart the broker with `launchctl kickstart -k gui/$(id -u)/local.jam-bot.environment-host`. Removing its LaunchAgent leaves registered data volumes and application services available for explicit retirement.

## Bind an existing preview on the same host

Use an observation binding when the existing project launcher already owns the web service and its dependencies. Add an exact repository ID and environment name to the host's private recipe catalog. Example recipe for a web server, API and optional existing Compose dependency:

```json
{
  "repoId": 12345,
  "environment": "local-preview",
  "tier": "development",
  "existingLocal": {
    "web": {"port": 5173, "path": "/"},
    "api": {"port": 3000, "path": "/health"},
    "docker": {"project": "project-dev", "service": "db"}
  }
}
```

Use the project's actual ports and Compose labels. Omit optional API and Docker checks when the project has none. Reload the management host after updating the catalog. Call `environment_upsert` on the selected repository with the same environment and tier, `binding: "existing-local"` and `settings: {}`. The server saves the verified binding to the topic's `environments/<name>/definition.json`. Repeating the upsert preserves the environment. Use `environment_status` to see the web and API URLs and HTTP status codes, plus the matched dependency's container identity and state. Health requires a successful response from each configured endpoint and a running dependency that passes its configured Docker health check, when present. Probes stay on loopback and stop at redirects. The existing project's launcher retains responsibility for starting, stopping and updating the stack.
