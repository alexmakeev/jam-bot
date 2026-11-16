# Static object-store publication through management

The authenticated `environment_deploy` operation selects a repository, environment and exact commit. The host resolves the approved image, Git ref, build recipe, bucket, object prefix, secret binding and cache resource from its private catalog. The static publisher uses the same operator authorization and stable-tier approval checks as the container publisher. The CLI, REST and MCP transports invoke the same operation.

Use `environment_upsert` to save a named staging or development environment with `settings.secretRefs` containing the credential alias. Leave its application variables and port empty. Register the environment's exact name on the host. For a site using a Node distribution build, the following illustrates its operator record:

```json
{
  "repoId": 12345,
  "environment": "site-preview",
  "tier": "staging",
  "releases": {"<approved 40-character Git SHA>": "sha256:<immutable builder image ID>"},
  "secrets": {"site-publish": "/absolute/private/site-preview.json"},
  "staticSite": {
    "repository": "owner/repository",
    "ref": "dev",
    "build": "npm-dist",
    "credentialRef": "site-publish",
    "region": "us-east-1",
    "s3Endpoint": "https://s3.example.org",
    "bucket": "site-preview",
    "prefix": "",
    "publicBase": "https://preview.example.org/",
    "cache": {
      "mode": "ssh-resource",
      "sshHost": "site-cache-host",
      "resource": "site-preview"
    }
  }
}
```

The operator provisions the bucket and website or proxy routing before deployment, including public-read policy for the site's generated assets where the origin uses anonymous requests. Keep private content under separate policy boundaries. HTTP is accepted only on IPv4 loopback for local pilots. The S3 client uses path-style requests and AWS Signature Version 4. The credential file is operator-owned, mode 0600, with string fields `accessKeyId` and `secretAccessKey` and optional `sessionToken`. For tenant-qualified keys supply the provider's complete access key ID. Scope cloud credentials to reads and writes of the site's object keys and the listing permission required to distinguish absent keys. No object deletes, bucket policy replacements or website configuration writes occur during deployment.

The `npm-dist` builder runs on an isolated, unprivileged Docker container with network disabled. Prepare the immutable builder image with Node, npm, shell utilities, the reviewed lockfile at `/opt/build/package-lock.json` and the corresponding installed dependencies at `/opt/build/node_modules`. The host fetches the exact approved Git revision, checks its ancestry on the registered branch and strips Git metadata. It mounts the checkout read-only, checks the lockfile, runs the repository's build script in scratch space and collects its `dist` output. The builder receives no cloud, GitHub or SSH credentials. The concrete Test and Sandbox recipes compile their TypeScript calculator modules with the pinned project compiler and package each module under the approved revision. A host recipe is required for a different output layout.

A release contains `index.html`, immutable files under `assets/releases/<release>/` and a SHA-256 build manifest. The host rejects links, unexpected mutable paths, oversized distributions and mismatched manifests. The prepared bytes are stored privately by repository, SHA and builder image, allowing retries to reuse the same files even for builds with timestamped release directories. Assets are uploaded and read back before switching the index. Prior asset versions remain accessible to open tabs. The publisher then purges the single registered cache resource, reads the ordinary public URLs through the cache and compares every object with its expected digest. An SSH resource uses the operator's pinned host key and the fixed resource-specific purge utility. Alternatively use a registered `https-purge` URL with optional secret-file field `cacheToken` for a resource-specific POST endpoint.

A purge or verification failure leaves the rollout unconfirmed. Reads from S3 may already see the new index. A retry reuses the prepared files, checks existing bytes, and completes cache verification. To roll back, deploy an earlier explicitly registered SHA with its retained build. The `environment_stop` operation does not delete shared website content. Set `includePublication: true` in the deploy or status request to receive the public URL, verified manifest digest, object count and verification time. Status reads also check the current index from the origin and the public cache. Host receipts are in `~/.jam-bot/management/s3-state/<repoId>/<environment>/current.json`.

The local acceptance pilot uses two separate S3-compatible buckets and cache resources. The Test and Sandbox MCP deployments compiled their own approved SHAs, served both working calculators and retained their earlier assets. A forced HTTP 503 from the Sandbox cache purge caused deployment to fail and status to report an unconfirmed revision. A retry passed, then the latest approved Sandbox SHA was restored. This exercise used laptop loopback endpoints; a real cloud deployment also requires its operator's bucket permissions, fixed public URL, verified cache SSH identity and pinned build image.

A read-only rehearsal of Vsemu main `4b07a0f5a0bbe0906473eee5b932a0761408893f` used its actual lockfile and the offline `npm-dist` recipe. It produced 154 verified files, including the entry point and release assets. No Vsemu bucket or cache credentials were used. Batches permit four concurrent object requests; all asset checks complete before the manifest and index are published.
