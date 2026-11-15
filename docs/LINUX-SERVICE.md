# Run the receiver and Git publisher on Linux

The Linux installation runs the Ubuntu receiver under Docker Compose and the scoped Git publisher under a user systemd timer. The host also runs the environment deployment broker. The receiver has a persistent state volume, a writable service home and Claude profile, and read-only GitHub App and management verifier files. Git and Docker credentials used by the publisher stay in the operator account.

## Install

Use a Linux account with Docker access and a running systemd user manager. Install Docker Engine and Compose v2, Git, GitHub CLI, a supported Node.js 22 release with `node:sqlite`, npm, and `flock`. Authenticate GitHub CLI as the account authorized to publish to each selected project. Clone JAM-Bot. The installer runs `npm ci` in a fresh checkout. For unattended reboot the Docker service must be enabled. The installer enables user lingering through `loginctl` or prints the administrative command if required.

Create a private environment file using [the documented service variables](SERVICE.md). Use absolute Linux paths for the webhook secret and GitHub App key, both readable by the service UID. Set `JAM_MANAGEMENT_HOSTS` to your authenticated public TLS hostname and any allowed local authorities. Omit the repository binding variables for an empty project list. The installer creates the server identity and private owner token and records the service user's numeric UID/GID for Linux bind mounts. `JAM_RECEIVER_IMAGE` can identify an existing locally loaded receiver image. By default the installer builds `jam-bot-local-service:latest` when absent.

Optionally provide a private JSON publisher catalog. Register repository names and trusted local test image IDs. The publisher supports `node-strip` and `typescript-build`. Pin the image to its locally verified `sha256:` ID. For example, generate the file using the actual image already present on your machine.

```sh
umask 077
export PUBLISH_REPOSITORY=owner/project
export PUBLISH_IMAGE=$(docker image inspect jam-bot-local-service:latest --format '{{.Id}}')
node -p 'JSON.stringify({projects:{[process.env.PUBLISH_REPOSITORY]:{image:process.env.PUBLISH_IMAGE,recipe:"node-strip"}}}, null, 2)' > publisher.json
scripts/linux/install-service.sh /absolute/path/to/service.env "$PWD/publisher.json"
```

The first installation can omit the catalog argument. No repository is authorized for publishing until the operator registers one. Reinstallation reloads Compose and preserves an unchanged running receiver and its existing publisher catalog if none is supplied. An explicit catalog replaces its contents. The receiver uses loopback port 19739 by default. Configure your existing HTTPS ingress to reach it and preserve the original Host and Authorization headers. See [management setup](MANAGEMENT.md) and [environment recipes](ENVIRONMENT-RUNNER.md).

## Verify and operate

```sh
systemctl --user status jam-bot-receiver.service jam-bot-publisher.timer jam-bot-environments.service
journalctl --user -u jam-bot-receiver.service -u jam-bot-publisher.service
curl --fail http://127.0.0.1:19739/health
loginctl show-user "$USER" --property=Linger
```

A successful receiver unit is active (exited). Docker manages the running container. The timer invokes the publisher every few seconds and an OS lock prevents overlapping scans. Inspect Compose with `docker compose --env-file service.env -f compose.service.yaml ps` from `~/.jam-bot/service`. Stop the receiver with `systemctl --user stop jam-bot-receiver.service`; stop publisher scans with `systemctl --user stop jam-bot-publisher.timer`. Restart the corresponding units to resume. The state volume, credentials and pending requests persist across shutdown. After an interruption during a Git push, reconcile the remote revision with the recorded request before retrying the publisher.

## Isolated startup acceptance

The Ubuntu 22.04 acceptance machine ran systemd 249 and its own Docker 27.5 daemon inside a private cgroup namespace, with no access to the Mac Docker socket or real credentials. Both booted with user lingering enabled. The receiver and publisher were stopped, an intake record was queued, and a Git seed request was left in the publisher exchange. Restarting the entire Ubuntu test machine started both units. The intake fixture returned one acknowledgment with the existing lead ID. Redelivering its ID left exactly one record and one invocation, and the publisher returned a Git bundle whose head matched the seeded upstream branch. This restart test used a deterministic intake acknowledgment and a local Git upstream.
