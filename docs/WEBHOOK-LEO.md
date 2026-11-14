# GitHub event routing and local coordinator acceptance

GitHub delivers signed events to one service on the owning machine. The service routes each event to an explicitly configured repository before invoking its coordinator. The local experiment recognizes opened issues, the fixed checksum acceptance task and explicitly approved [Leo Developer work cards](LEO-DEVELOPER.md). See the requirements in PRD JB-02, JB-26 and JB-34 for general discovery, approval and ownership.

## Topic configuration

Start the service with the installation procedure in [SERVICE.md](SERVICE.md). The primary topic uses `JAM_REPOSITORY`, `JAM_REPOSITORY_ID` and `JAM_INSTALLATION_ID`. Set `JAM_ADDITIONAL_TOPICS` to a JSON array to add repositories. Each entry contains `repository` (owner/name), `repoId` and `installation` (positive integer IDs). Duplicate repository IDs or names fail startup.

The primary journal and Claude working directory retain their original locations at `JAM_STATE_DIR/intake.sqlite` and `JAM_STATE_DIR/leo`. Additional topics use the same layout beneath `JAM_STATE_DIR/topics/<installation>/<repoId>`. The database migration preserves existing receipts, queue state, manual resolutions and the recorded Claude session UUID. The service validates the stored topic binding and preallocates an identity for every new coordinator. The machine-wide service lock prevents two consumers from using the same journals.

## Delivery

1. The receiver accepts a raw body of at most 2 MiB at `POST /github`. It checks the HMAC-SHA256 signature before parsing. A body over the limit receives HTTP 413. Unknown repository/installation pairs or mismatching repository names on supported issues events receive HTTP 403. Signed pings and irrelevant event types receive HTTP 204.
2. For each supported event, require a personal repository and verify that the immutable sender and issue author IDs both match the personal owner. Organization roles require a separate intake check. Ignore other senders and authors before persisting issue text or calling Claude.
3. An opened issue enters the repository's intake queue. A locked event qualifies separately if the signed payload identifies the owner as the lock actor, the issue is locked and its entire body matches the fixed worker acceptance recipe or the scoped profile card format. Ordinary locks do not enqueue work. This allows either notification to arrive first. Repeated delivery IDs and repeated notifications of the same action for the same issue share a single journal row.
4. Commit before HTTP 202. SQLite uses WAL, full synchronous commits, a Docker named volume and a startup integrity check. Each repository consumes its own queue serially. Model calls in one repository can proceed while another waits. Independent journals and Claude working directories separate task state. The shared container remains the authority boundary.
5. Leo receives the bound repository name, issue number and delivery UUID. Issue title and body stay out of the conversational input. The intake call runs with skills, tools, agent customizations and external MCP disabled. Validate its structured receipt and matching Claude session UUID before marking the row received. An ordinary receipt ends here.
6. For a recognized locked work card, persist a pending worker intent in the same transaction as the verified Leo receipt. Claim the intent before calling the worker handler, then record completion or a review reason. The handler verifies current authorization and card state before dispatching the local checksum exercise through the same repository coordinator. The signed lock alone does not grant approval for arbitrary tasks.

## Recovery and inspection

The owner process holds `JAM_STATE_DIR/owner.lock` using Linux flock. Keep the journal on its named volume, the coordinator working directory at the same container path and the subscription available. Node 22.13 or later is required. The public `GET /health` checks the listener and journal availability. Review blocked deliveries locally.

Run `node dist/src/webhook-service.js review list` in the receiver container. It defaults to the primary topic. Set `JAM_REVIEW_REPOSITORY=owner/name` for another configured topic. Each event shows its action, receipt state, worker state and review reason. A pending worker intent survives restart. A started invocation without a confirmed result changes to review on restart. It can block that repository; other repositories continue.

For an ambiguous intake result, inspect the coordinator session and use `review resolve DELIVERY acked|abandon|requeue OPERATOR resume|unused`. Choose unused only when the session has no prior invocation. A locked test card requires a verified coordinator receipt before worker dispatch. For ambiguous worker execution, inspect its artifacts and the coordinator transcript, then use `review resolve-worker DELIVERY complete|abandon OPERATOR`. Record the operator's identity. Resolving a worker claim does not replay that external invocation.

## Verification

The router tests exercise signature and size checks, immutable topic routing, separate session identities, outsider rejection, full-body matching, lock-before-open and duplicate delivery. Migration and restart tests preserve legacy receipt/session identity and ensure ambiguous worker execution cannot start twice. A live acceptance run should match the GitHub issue, delivery, coordinator UUID and worker evidence in each repository independently.

The two-repository run on November 14, 2026 completed automatically from signed GitHub deliveries through the AM32 tunnel. [Test work card](https://github.com/alexmakeev/jam-bot-test/issues/9) and [Sandbox work card](https://github.com/alexmakeev/jam-bot-sandbox/issues/2) each received a separate coordinator receipt and a verified checksum from a named in-process Claude Code teammate. The verifier matched the spawn handle, team roster, developer's outbound message and coordinator's inbox before recording completion. Earlier print-mode trials were retired because their traces could not establish team membership. The fixed acceptance recipe exercises delegation; general code-editing work cards are outside this experiment.
