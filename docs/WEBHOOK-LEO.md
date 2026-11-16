# GitHub event routing and local coordinator acceptance

GitHub delivers signed events to one service on the owning machine. The service routes each event to an explicitly configured repository before invoking its coordinator. The local experiment recognizes opened issues, the fixed checksum acceptance task and explicitly approved [Leo Developer work cards](LEO-DEVELOPER.md). See the requirements in PRD JB-02, JB-26 and JB-34 for general discovery, approval and ownership.

## Topic configuration

Start the service with the installation procedure in [SERVICE.md](SERVICE.md). The primary topic uses `JAM_REPOSITORY`, `JAM_REPOSITORY_ID` and `JAM_INSTALLATION_ID`. Set `JAM_ADDITIONAL_TOPICS` to a JSON array to add repositories. Each entry contains `repository` (owner/name), `repoId` and `installation` (positive integer IDs). Duplicate repository IDs or names fail startup.

The primary journal and Claude working directory retain their original locations at `JAM_STATE_DIR/intake.sqlite` and `JAM_STATE_DIR/leo`. Additional topics use the same layout beneath `JAM_STATE_DIR/topics/<installation>/<repoId>`. The database migration preserves existing receipts, queue state, manual resolutions and the recorded Claude session UUID. The service validates the stored topic binding and preallocates an identity for every new coordinator. The machine-wide service lock prevents two consumers from using the same journals.

## Delivery

1. The receiver accepts a raw body of at most 2 MiB at `POST /github`. It checks the HMAC-SHA256 signature before parsing. A body over the limit receives HTTP 413. Unknown repository/installation pairs or mismatching repository names on supported issues events receive HTTP 403. Signed pings and irrelevant event types receive HTTP 204.
2. An issue created as a native Task, or explicitly assigned that type by a human, is eligible for approval. An untyped draft, an intake report and a conversation lock do not authorize execution.
3. Verify repository binding and human identity before storing scope. When a collaborator approves another collaborator's work card, check the author of the content separately. The session receives a notification identifying the approved work card.
4. Persist the signed approval as an admission intent before contacting GitHub to lock the issue. Admission rechecks current roles, issue type and approved scope, locks the conversation immediately and verifies the result before queuing the task for Leo or acknowledging acceptance. Another active model session cannot delay this lock. Repeated matching deliveries share the original intent. A changed actor or scope conflicts with that intent. A restart resumes unfinished lock operations, including a successful remote lock whose local confirmation was interrupted.
5. A repository has its own session, work directory and queue. Its default class determines the ordinary route. The service projects current progress through status labels and keeps the approval and resolved class in its journal.


## Recovery and inspection

The owner process holds `JAM_STATE_DIR/owner.lock` using Linux flock. Keep the journal on its named volume, the coordinator working directory at the same container path and the subscription available. Node 22.13 or later is required. The public `GET /health` checks the listener and journal availability. Review blocked deliveries locally.

Run `node dist/src/webhook-service.js review list` in the receiver container. It defaults to the primary topic. Set `JAM_REVIEW_REPOSITORY=owner/name` for another configured topic. Each event shows its action, receipt state, worker state and review reason. A pending worker intent survives restart. A started invocation without a confirmed result changes to review on restart. It can block that repository; other repositories continue.

For an ambiguous intake result, inspect the coordinator session and use `review resolve DELIVERY acked|abandon|requeue OPERATOR resume|unused`. Choose unused only when the session has no prior invocation. A locked test card requires a verified coordinator receipt before worker dispatch. For ambiguous worker execution, inspect its artifacts and the coordinator transcript, then use `review resolve-worker DELIVERY complete|abandon OPERATOR`. Record the operator's identity. Resolving a worker claim does not replay that external invocation.

## Verification

The router tests exercise signature and size checks, immutable topic routing, separate session identities, outsider rejection, full-body matching, lock-before-open and duplicate delivery. Migration and restart tests preserve legacy receipt/session identity and ensure ambiguous worker execution cannot start twice. A live acceptance run should match the GitHub issue, delivery, coordinator UUID and worker evidence in each repository independently.

The two-repository run on November 14, 2026 completed automatically from signed GitHub deliveries through the AM32 tunnel. [Test work card](https://github.com/alexmakeev/jam-bot-test/issues/9) and [Sandbox work card](https://github.com/alexmakeev/jam-bot-sandbox/issues/2) each received a separate coordinator receipt and a verified checksum from a named in-process Claude Code teammate. The verifier matched the spawn handle, team roster, developer's outbound message and coordinator's inbox before recording completion. Earlier print-mode trials were retired because their traces could not establish team membership. The fixed acceptance recipe exercises delegation; general code-editing work cards are outside this experiment.

### Repository access changes

Signed GitHub App installation and repository grant webhooks enter a durable per-repository queue before acknowledgment. Registration uses the same project connector as the management API and MCP. The host accepts its configured installation, installations already bound to a topic, or explicitly listed numeric GitHub account IDs in `JAM_AUTO_CONNECT_ACCOUNT_IDS`. Each repository name, immutable repository ID, installation, account, and current Issues write grant are verified against GitHub.

Removing repository access pauses its consumer, removes its active management route, and retains its directory, coordinator identity, queue and history. The publisher checks the local revocation marker before accepting work and before pushing. Regranting access to the same repository on the installation reopens that directory. Current GitHub access determines the result of delayed events. A different repository ID behind the same name requires reconciliation. A transient error retries the individual repository independently.
