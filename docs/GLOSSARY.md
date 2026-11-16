# JAM-Bot glossary

Canonical English terms apply to all project documents. Russian aliases help map prior discussion; they are not alternate API names.

| Canonical term | Meaning and Russian aliases |
| --- | --- |
| JAM-Bot | Product name (джем-бот); repository: jam-bot. |
| coordinator / JAM | Repository's root agent and primary conversational contact (координатор, JAM). |
| developer / issue worker | Agent responsible for implementing an approved work card (разработчик, воркер задачи). |
| architect | Role producing a sufficient specification before development (архитектор). |
| integrator | Role assembling and verifying a candidate; a fresh instance also handles RC fixes (интегратор). |
| teammate | Member of a harness Agent Team with its own session (участник команды). Not a subagent. |
| subagent | Short-lived delegated agent within a harness workflow (субагент). Not a separately managed teammate. |
| harness | Agent execution environment; Claude Code is the first default (агентная среда). |
| issue | GitHub discussion/card container (issue, обращение). May hold an intake report or execution work card; not a PR. |
| intake report | Original bug report or feature request, preserved separately from execution (исходное обращение). |
| execution work card / task | Separate linked card describing executable work; human approval required (рабочая карточка, задача). |
| pull request / PR | GitHub change/review discussion associated with a branch (пул-реквест). |
| feature branch | Branch for one approved work card's implementation (ветка задачи). |
| worktree | Git working tree associated with a branch (рабочее дерево). Not a security boundary. |
| specification / spec | Attached Markdown describing sufficient implementation intent, contracts, dependencies, and tests (спецификация). |
| checkpoint | Compact progress and resumption record kept locally in the assigned worktree (контрольная точка). |
| candidate | Local combined revision awaiting full validation (кандидат). |
| local staging | Separate local environment for candidate verification (локальный стенд). Not production. |
| release candidate / RC | Verified main revision undergoing acceptance (релиз-кандидат). |
| promotion | Controlled advancement of a verified revision to a shared branch (продвижение). |
| stable | Maturity designation after acceptance; not production deployment (стабильная версия). |
| phase | Proposed structured workflow stage (фаза); preserved while waiting; planning begins architect work and in-progress begins developer acceptance. |
| waiting reason | Explicit cause preventing progress, such as a dependency or unanswered request (причина ожидания). |
| request / answer | Correlated asynchronous protocol exchange with explicit recipient (запрос, ответ). Names and schemas remain proposals. |
| source of truth | Project-level authoritative remote cards, specifications, discussions, and code; task truth is a narrower subset (источник истины). |
| repository URI | MVP project identity (URI репозитория); rename/transfer handled manually for now. |
| permission / authorization | Enforced right to perform an action (право, разрешение). Reading an event or mentioning someone does not grant it. |
| responsibility | Semantic expertise used for optional question routing (область ответственности), distinct from GitHub access roles. |
| topic | Binding of a concrete source of truth, work profile, and environment (топик). |
| work profile | Concrete harness recipe: command, instructions, hooks, tools/MCP, settings, and credential references (рабочий профиль). |
| orchestrating harness | Configured harness responsible for internal agent and consultant orchestration (оркестрирующая агентная среда). |
| required dependency | Tool/access that must be available before startup (обязательная зависимость). |
| optional dependency | Tool/access used when configured, with profile-defined runtime failure handling (необязательная зависимость). |
| human approval | Authorized human decision allowing execution, attributable to a trusted human, including authenticated conversation; projected through an approval label (одобрение человеком). Not queue state. |
| queue state | Readiness/execution status subject to dependencies and resource availability (состояние очереди). |
| management API | JAM-Bot administrative REST/OpenAPI operations, shared by thin CLI/MCP interfaces (API управления). Not the agent communication protocol. |
| agent communication protocol | Validated requests, answers, transitions, and checkpoints between agents (протокол общения агентов). |
| routing map | Durable mapping from project/source URI to server and topic (карта маршрутизации). Not authorization. |
| reconciliation | API-based recovery of missed remote state/events alongside primary webhooks (сверка состояния). |
| relay | Future optional service forwarding webhooks and MCP to outbound-connected private instances (ретранслятор). Outside MVP. |
| ownership fence | Evidence preventing an old machine from executing or mutating after reassignment (ограждение владельца). Silence alone is insufficient. |
| values | Project principles guiding autonomous decisions and escalations (ценности). |
| consultant fan-out | Parallel consultation awaiting every successful response, possibly with an empty list (параллельные консультации). |
| build approval | Explicit maintainer decision bound to one exact SHA, invalidated on revision change (одобрение сборки). |
