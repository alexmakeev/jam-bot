# Isolated Antigravity consultant

Build the CLI with `docker build -t jam-antigravity-cli:local scripts/antigravity` and run `scripts/antigravity/setup-network.sh` on the publisher host. The installer is Google's official Linux installer and checks the binary against the SHA-512 release manifest. The immutable deployed image ID is available with `docker image inspect -f '{{.Id}}' jam-antigravity-cli:local`.

Create the dedicated volume with `docker volume create jam-antigravity-home`. Sign in once using Google's account in the interactive CLI. The following command prints Google's sign-in URL and accepts its single-use code in the same terminal.

```sh
docker run --rm -it --read-only --cap-drop ALL --security-opt no-new-privileges \
  --network jam-antigravity-private --user 1000:1000 --tmpfs /tmp \
  -e HTTPS_PROXY=http://jam-antigravity-provider-proxy:3130 \
  -e HTTP_PROXY=http://jam-antigravity-provider-proxy:3130 \
  -e 'SSH_CONNECTION=127.0.0.1 22 127.0.0.1 22' \
  --mount type=volume,src=jam-antigravity-home,dst=/home/jam \
  jam-antigravity-cli:local
```

Register the image ID, the volume name `jam-antigravity-home`, and the optional approved model in the host publisher profile. Each request gets a fresh CLI process with an empty working directory. The host sends the review on standard input. Model actions for files, commands, web browsing and MCP are explicitly denied. The CLI can update its own session inside the volume. The container reaches the provider through an allowlisted HTTPS CONNECT proxy on an internal Docker bridge. The proxy binds to that bridge only and does not decrypt traffic. No project checkout, host browser storage, SSH key or Docker socket is mounted.

Verify a profile by requesting a one-sentence review containing a unique fact from the packet and checking the returned answer. Logs about a denied provider destination identify connectivity issues without recording packet contents. [Google installation and authentication](https://antigravity.google/docs/cli/install) · [CLI permissions](https://antigravity.google/docs/cli/permissions)
