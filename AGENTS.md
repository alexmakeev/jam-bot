# Project instructions

- Product name: **JAM-Bot**. Repository: `jam-bot`. License: MIT; preserve the existing LICENSE.
- This project is in requirements discussion. Documentation updates do not authorize implementation, task creation, service setup, or deployment. Issue #1 explicitly authorizes the TypeScript/Node.js local recovery prototype; production and unrelated implementation remain unauthorized.
- Write all documents in English, including drafts, intermediate documents, specifications, checkpoints, and architectural Markdown attachments produced by agents. Russian aliases are allowed in the glossary.
- Use canonical terms from [docs/GLOSSARY.md](docs/GLOSSARY.md). Do not conflate teammates with subagents, issues with pull requests, or mentions with authorization.
- Keep [docs/PRD.md](docs/PRD.md) the single requirements source of truth. Separate confirmed requirements, proposals, open questions, and non-goals. Preserve short requirement IDs; avoid duplicating requirements across files.
- Add GitHub-compatible Mermaid diagrams when they clarify processes, interactions, states, dependencies, or entities, including in intermediate documents. Prefer flowchart, sequenceDiagram, or stateDiagram-v2 as appropriate. Do not add decorative diagrams merely to satisfy a template. See [GitHub diagram documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams). GeoJSON, TopoJSON, and STL are not needed for these process diagrams.
- Prefer thin scripts and wrappers. Explain the complexity cost of scope growth and offer a simpler alternative. Do not build a general workflow engine, subscription manager, or duplicate the harness's agent management.
- Preserve existing work. Do not treat proposals or unverified harness capabilities as implemented facts.
- Bot comments should be one short paragraph; an initial task may use two or three. Put substantial detail in attached English Markdown files, not long inline comments. Automated attachment delivery remains unverified.
- Do not publish a final competitive assessment until the user explicitly requests it.

- Distinguish intake reports from execution work cards: only authorized-human-approved work cards may execute; bots cannot self-approve. Approval is separate from queue state.
- Distinguish project source of truth, topic, work profile, and orchestrating harness. Build concrete recipes, not arbitrary compatibility machinery.
- Keep management REST/OpenAPI and its thin MCP interface separate from the agent communication protocol. Share application operations across CLI/REST/MCP. TypeScript is selected; Node.js runs the prototype. Python is excluded.
- MVP networking requires public IP, reachable HTTPS, primary verified webhooks, and authenticated remote management MCP. API reconciliation is for recovery, not a primary polling loop. A future private-machine relay is outside MVP.

- Trusted human conversation approval is sufficient when work cards retain verifiable attribution; no second click. Labels project approval, not prove it. Small scope adjustments follow goals/values; escalate strategic ambiguity, conflicts, or dead ends.
- Read managed project .jam-bot/VALUES.md before changes and after recovery; absence does not block initially approved work. Human-facing Codex alone may load the relevant optional vocab.<lang>.json.
- Recovery compares actual code, card and checkpoint. Warn on conflicting ownership and prevent duplicate execution.
- Stable requires explicit human approval of the exact build SHA. Keep original/fix specs as .md attachments in the original issue, never substitute repository links.
