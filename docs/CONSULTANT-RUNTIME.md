# Independent consultant runtimes

The host publisher reads the optional `consultants` array from each repository entry in its private catalog. A development Task supplies its verified approval, phase and bounded evidence. The host rechecks the original issue and both human identities. Architecture, implementation and diagnosis consultations send their packet to every configured provider concurrently and return one result per configured name. An empty array returns immediately. Provider credentials remain on dedicated Docker volumes. A consultation container receives its packet on standard input and has no repository checkout, host home, Docker socket or GitHub credential.

## Connect Codex

Build the CLI image, create a dedicated authentication volume, and start the official device login. Enter the code from the terminal in the official OpenAI browser page. A new container using this volume can verify the login after the first container exits.

```sh
docker build -t jam-codex-consultant:0.169.0 scripts/consultants/codex
docker volume create jam-codex-consultant-home
docker run --rm -it --mount type=volume,src=jam-codex-consultant-home,dst=/home/jam/.codex jam-codex-consultant:0.169.0 login --device-auth
docker run --rm --mount type=volume,src=jam-codex-consultant-home,dst=/home/jam/.codex jam-codex-consultant:0.169.0 login status
docker image inspect --format '{{.Id}}' jam-codex-consultant:0.169.0
```

Copy the image ID printed in the last command into the repository's private publisher entry. Add the following array alongside its existing test recipe and image. Replace the example digest with that exact ID.

```json
{
  "consultants": [
    {
      "name": "Codex",
      "provider": "codex",
      "image": "sha256:<64 hexadecimal characters>",
      "volume": "jam-codex-consultant-home"
    }
  ]
}
```

Set an optional provider `model` or a per-profile `timeoutMinutes` from 1 to 30. The host defaults to a 30-minute ceiling. Failure records identify the provider and return a limited diagnostic. The Mac publisher scans other work while reviews are in flight. Install updated broker scripts with the existing publisher installer. The CLI receives an empty workspace in a read-only image containing only its static binary and CA certificate bundle. Shell, remote apps, plugins, filesystem execution and web search tools are disabled for reviews. See the [official OpenAI authentication guide](https://developers.openai.com/codex/auth/).
