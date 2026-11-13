# JAM-Bot glossary

Canonical English terms apply to all project documents. Russian aliases help map prior discussion; they are not alternate API names.

| Canonical term | Meaning and Russian aliases |
| --- | --- |
| JAM-Bot | Product name (джем-бот); repository: jam-code. |
| coordinator / Leo | Repository's root agent and primary conversational contact (координатор, Лео). |
| developer / issue worker | Agent responsible for implementing an issue (разработчик, воркер задачи). |
| architect | Role producing a sufficient specification before development (архитектор). |
| integrator | Role assembling and verifying a candidate; a fresh instance also handles RC fixes (интегратор). |
| teammate | Member of a harness Agent Team with its own session (участник команды). Not a subagent. |
| subagent | Short-lived delegated agent within a harness workflow (субагент). Not a separately managed teammate. |
| harness | Agent execution environment; Claude Code is the first default (агентная среда). |
| issue / task card | GitHub issue describing a task and its authoritative records (задача, карточка). Not a PR. |
| pull request / PR | GitHub change/review discussion associated with a branch (пул-реквест). |
| feature branch | Branch for one issue's implementation (ветка задачи). |
| worktree | Git working tree associated with a branch (рабочее дерево). Not a security boundary. |
| specification / spec | Attached Markdown describing sufficient implementation intent, contracts, dependencies, and tests (спецификация). |
| checkpoint | Compact durable progress and resumption record (контрольная точка). |
| candidate | Local combined revision awaiting full validation (кандидат). |
| local staging | Separate local environment for candidate verification (локальный стенд). Not production. |
| release candidate / RC | Verified main revision undergoing acceptance (релиз-кандидат). |
| promotion | Controlled advancement of a verified revision to a shared branch (продвижение). |
| stable | Maturity designation after acceptance; not production deployment (стабильная версия). |
| phase | Proposed structured workflow stage (фаза); final vocabulary is open. |
| waiting reason | Explicit cause preventing progress, such as a dependency or unanswered request (причина ожидания). |
| request / answer | Correlated asynchronous protocol exchange with explicit recipient (запрос, ответ). Names and schemas remain proposals. |
| source of truth | Authoritative record: GitHub task cards/specs/checkpoints for tasks; remote branches for code (источник истины). |
| repository URI | MVP project identity (URI репозитория); rename/transfer handled manually for now. |
| permission / authorization | Enforced right to perform an action (право, разрешение). Reading an event or mentioning someone does not grant it. |
| responsibility | Semantic expertise used for optional question routing (область ответственности), distinct from GitHub access roles. |
