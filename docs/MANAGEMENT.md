# Managing a JAM-Bot instance

Each service has a persistent instance ID and reports its repository inventory. An owner can use a compatible MCP client, the HTTP API, or the repository CLI to manage that instance. Ordinary project discussion and work-card approval still take place in the project's established workflow. Management access authorizes changes to the instance and carries no implicit human approval of a GitHub work card.

## Connect a client

Use the instance's HTTPS origin. The Streamable HTTP endpoint is `/mcp`. Configure a client that supports a secret bearer header and obtain the operator credential from the host's protected credential store. The endpoint checks the destination host and credential before listing tools. Keep the token out of conversation transcripts, project config and command history. The receiver configuration, host deployment recipes and credentials are separate from environment definitions. See [host runner](ENVIRONMENT-RUNNER.md).

The HTTP API publishes its authenticated OpenAPI 3.1 document at `/api/v1/openapi.json`. It includes resource routes, operation inputs, outputs and errors generated from the same definitions used by MCP. Clients can invoke any documented operation using `POST /api/v1/operations/<name>` with a JSON object. The exact tool list is also available through MCP discovery.

Build the CLI from this checkout. Register a named endpoint with a path to its token file, then inspect the available projects.

```sh
npm ci
npm run build
node dist/src/management-cli.js add home https://jam-bot.example.org /private/path/owner.token
node dist/src/management-cli.js inventory home
node dist/src/management-cli.js route https://github.com/OWNER/REPO topic_status '{}'
```

The CLI retains the server ID and project placement in the operator's home directory. It reads the bearer from the separate file on each request. When live placement changes, inspect the inventory. When more than one server advertises the same project, select the named endpoint explicitly. An owner can configure several named endpoints without running a fleet service.

## Connect a repository

1. Install the instance's GitHub App on the repository with metadata read access and Issues write access.
2. Discover the installation with `list_installations` and inspect its granted repositories with `available_projects`.
3. Call `connect_project` with the current server ID, canonical GitHub repository URI and installation ID. The service checks GitHub, creates the project's directories and starts its coordinator consumer. Retrying the same connection preserves the journal and session. New bindings survive restart. Existing installer-managed topics keep their original locations.
4. Use `configure_topic` to select the repository's default work class or bind a saved environment. Ordinary Tasks use the repository's configured default.

## Start an approved Task

On a single-owner endpoint with a linked GitHub identity, call `task_authority` to verify the delegated human and current repository access. Use `task_create` after that human approves the actual title and scope in the conversation. Keep the request UUID when retrying. The result contains the original GitHub issue URL. The signed native Task webhook starts the normal workflow. See [host identity binding and recovery](SERVICE.md#starting-a-task-from-a-trusted-owner-conversation).

## Configure and deploy an environment

In a project conversation, an operator might ask to create a staging environment, select its nonsecret application parameters and associate it with the project. The client resolves the instance and repository and calls `environment_upsert`. The definition persists under `environments/<name>/definition.json` in that project's state directory. A separate `environment_deploy` request targets an exact revision admitted by a local machine recipe. `environment_status` checks the actual container and `environment_stop` stops that instance. The lifecycle tier is fixed on first creation. A stable deployment also requires verifiable human approval of the exact revision.

For a deployment that may outlive the request, invoke `start_environment_deployment` with a fresh UUID in `requestId`, then retrieve `operation_status` using the same target and ID. Retry the original request with its original ID. If the service restarts during execution, inspect actual environment status and the interrupted operation before starting another deployment. Status, configuration and deployment share the host's repository/environment authorization boundary. Fresh machines need a locally provisioned recipe and eligible release image before deploying that project.

## Reconcile existing work

Use `topic_status` for recent deliveries, worker state, ready revisions and the active integration batch. Use the existing journal reconciliation operations only after inspecting the work and its evidence. A conflicting state returns an error. Normal authenticated management reads do not trigger a model turn.

For a Codex client with the owner bearer provisioned in its environment, configure a native remote endpoint with its URL and the **name** of that environment variable. For example, `codex mcp add jam-bot-home --url https://jam-bot.example.org/mcp --bearer-token-env-var JAM_BOT_OWNER_BEARER`. Provision the value privately in that client's launch environment. The CLI workflow above can use the protected token file directly. [Codex MCP configuration](https://developers.openai.com/codex/mcp/)

## Install on a Docker host

Use Node 22.13 or later, Git, Docker Engine with Compose, and a service account that can run Docker. Run `npm ci` from the checkout. On macOS run `scripts/macos/install-environment-host.sh`. On a Linux machine with a user systemd manager run `scripts/linux/install-environment-host.sh` as the host operator. For Linux boot-time operation enable lingering for that account. The installed runner uses an OS lock and the operator's private recipe catalog. Reinstalling retains the server identity, releases and credential.

Set `JAM_SERVER_ID` in the receiver's private Compose environment from the generated `~/.jam-bot/management/server-id`. Set `JAM_MANAGEMENT_HOSTS` to the allowed HTTPS authority and the local health/debug authority you use. Configure the GitHub App and signed webhook as described in [service installation](SERVICE.md). Keep the receiver on loopback and forward the HTTPS routes through the trusted ingress. Keep the receiver UID able to read the mounted verifier and read/write its exchange directory. The API can start with zero topic bindings. In a shell, the owner can register a project after installing its GitHub App.

A desktop client may also keep the owner bearer in the registered endpoint's private file. Configure the native client's stdio command to run `node /absolute/path/to/dist/src/management-cli.js mcp home` using Node 22.13 or later. The named client verifies the saved server identity and forwards MCP discovery and tool calls to the authenticated HTTPS endpoint. Existing CLI endpoint registrations can be reused. The stdio command contains no token.
