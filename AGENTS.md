# Project instructions

- Product name: **JAM-Bot**. Repository: `jam-bot`. License: MIT; preserve the existing LICENSE.
- This project is in requirements discussion. Documentation updates do not authorize implementation, task creation, service setup, or deployment. Wait for a separate explicit instruction.
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
- Keep management REST/OpenAPI and its thin MCP interface separate from the agent communication protocol. Share application operations across CLI/REST/MCP. Python is excluded; implementation language remains undecided.
- MVP networking requires public IP, reachable HTTPS, primary verified webhooks, and authenticated remote management MCP. API reconciliation is for recovery, not a primary polling loop. A future private-machine relay is outside MVP.
