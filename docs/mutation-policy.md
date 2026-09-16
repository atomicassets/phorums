# Required mutation policies

A required policy adds a fail-closed boundary around protected forum writes.
The `mutations:requiredPlugin` setting names an installed, loaded plugin whose
`mutationPolicy` export implements `authorize`, `validate`, `check`, and
`receipt`. Without the setting, the legacy behavior remains available. When
it is set, protected operations reject a missing policy, a closed authorization
context, or a non-PostgreSQL backend.

Do not enable this setting without a complete policy and an entrypoint audit.
This core interface does not verify chain transactions, authenticate an HTTP
request, install a signing UI, or grant a plugin permission to manage roles.
Those responsibilities belong to the integration. Passing a client-supplied
`verified` boolean is never an authorization implementation.

## Execution

Call `mutations.run(request, perform)` from a trusted integration handler.
The policy's `authorize(request)` obtains and verifies external evidence before
any database lock is acquired. It returns a ticket with a 32-byte hexadecimal
nonce. Inside the transaction, `validate(ticket)` must re-check expiry,
identity, permissions, and the current target revision. Both checks must fail
closed when their evidence or dependencies are unavailable.

The `perform` callback calls the ordinary core methods. Their guards call
`check(ticket, action, args)`, which must return exactly `true` for each allowed
call, including nested calls and cascades. Canonical storage writes have an
additional `database.<method>` guard. A policy must authorize exact keys and
values; a broad database-method wildcard would bypass content commitments.

Guarded surfaces reach past the post and topic entrypoints. Group membership
transitions carry their own actions: `groups.requestMembership`,
`groups.acceptMembership`, `groups.rejectMembership`, and `groups.invite`.
Ownership transfer carries `posts.changeOwner`. Topic side records carry
`topics.thumbs.associate`, `topics.thumbs.delete`, `topics.events.purge`,
`topics.crossposts.add`, `topics.crossposts.remove`,
`topics.crossposts.removeAll`, and `topics.tools.setPinExpiry`. The mute and
unmute write paths are guarded on their API entrypoints as `user.mute` and
`user.unmute`, ahead of the first write. A nested surface keeps its own action,
so an outer operation that reaches one, such as a topic purge reaching
`topics.events.purge` and `topics.crossposts.removeAll`, needs both.

The canonical storage allowlist protects moderation history and ownership
indexes alongside content: `users:banned`, `users:banned:expire`, `users:muted`,
`users:flags`, the `uid:<uid>:ban*`, `unban*`, `mute*`, and `unmute*` history
keys, `uid:<uid>:posts`, `uid:<uid>:topics`, `uid:<uid>:cids`, `crosspost:*`, and
`uid:<uid>:crossposts`. A `flagId` field on a `user:<uid>` or `message:<mid>`
record is a moderation association and needs its own `database.<method>`
authorization.

`receipt(ticket, result)` validates the applied result and updates integration
revision records using the same database adapter before returning a JSON
receipt. It must omit plaintext content and other data unsuitable for its
consumer. A missing receipt aborts the transaction. Receipt generation cannot
make network requests or use an independent database connection.

The `mutation:*` namespace is reserved for core receipt persistence. Policies
and mutation callbacks cannot write evidence directly, including while enforcement is unset.

The mutation, nonce receipt, sequence, and outbox membership commit in one
PostgreSQL transaction. A shared advisory lock serializes protected mutations
and sequence allocation. This deliberately favors correctness over throughput.
Replay is rejected even when two processes submit the same nonce concurrently.
The transaction rolls back on storage or policy failure. If the connection is
lost during commit, query the persisted receipt before attempting recovery;
client-side failure alone cannot establish that PostgreSQL rolled back. A COMMIT
error retains its original identity and sets `mutationOutcome` to `unknown`; the
connection is discarded. Reconcile the nonce receipt before retrying.

## Cache and effects

Reads inside an atomic transaction bypass shared LRU caches, and uncommitted
values are never inserted into them. Invalidation, pubsub notifications, and
action hooks are deferred until commit. They are discarded on rollback.
Captured or detached transaction contexts cannot reuse a released connection.
Follow-up work that must run after the write, such as follower notifications,
goes through `atomic-context.detach`: inside a mutation it joins the post-commit
effects, outside one it runs on the next immediate.
Caught SQL errors still poison the transaction.

This boundary covers database state. Filesystem operations, email, direct socket
emissions, and external calls need their own review before an operation is
allowed by a policy. Defer irreversible effects or reject the operation. The
post-commit callback queue is not durable; use the outbox for reliable delivery.
Operations using independent PostgreSQL cursors, including group destruction and
updates, remain unavailable inside an atomic mutation. Operations scheduling
detached database work also remain unsupported until that work is deferred
explicitly. Flag purge/rescind, post queue mutation, upload association and
deletion, and orphan cleanup reject protected execution before irreversible
effects, even when a policy permits their action. User content removal and
account removal reject it as well, because they erase uploaded files and profile
folders from disk and revoke live sessions. A ban rejects it because its
notification email leaves before the transaction commits. Cover and avatar
changes reject it because they write and delete image files alongside the profile
picture index: `user.updateCoverPicture`, `user.updateCoverPosition`,
`user.uploadCroppedPictureFile`, `user.uploadCroppedPicture`,
`user.removeCoverPicture`, and `user.removeProfileImage`. Unbanning, topic
deletion, topic restoration, and `topics.tools.restore` carry no unrecalled
external effect and stay available. Keep every one of these guards installed and
reject the unsupported operation in the policy; removing a guard would reopen
unsigned writes.

Topic deletion defers its federated Remove instead of rejecting protected
execution. `Topics.delete` schedules the delivery through
`atomic-context.detach`, so inside a mutation it joins the post-commit effects
and a rollback discards it, and outside one it runs on the next immediate. A
failed delivery is logged and does not fail the deletion.

Work a write starts must either belong to its transaction or wait for the commit.
Database-only follow-up work is awaited inside the mutation, which covers the
last-online stamp and the inbox synchronization on a reply, the recent-topics
entry on a cross-category move, and the crosspost event purge on a crosspost
removal. Unread and notification counts are recomputed and emitted through
`atomic-context.detach`, so the number a client receives reflects committed state
and a rollback emits nothing. An unawaited call that outlives its mutation reads a
released connection, so it is a defect rather than an optimization.

## Read routes

`mutations.available()` reports whether a write may proceed: true when no policy
is required, and true inside an open verified context. A read route that writes
bookkeeping asks first and skips the write when the answer is false, logging at
verbose level rather than failing the page. This covers view counts and read
markers on a topic page, pin expiry during a listing, and the crosspost score
repair. The write itself keeps its guard, so the skip never becomes a bypass:
only the read-side call site decides to do nothing.

## Outbox consumption

`readOutbox(after, limit)` returns ordered, immutable receipt records after a
sequence, with a maximum page size of 100. It throws on missing evidence and
does not advance a delivery cursor. The consumer must authenticate its reader,
ingest by nonce idempotently, and commit its cursor with the corresponding
consumer records. No public receipt-reading route is supplied by this module.

Keep finalized receipts through content purges and rollbacks. Do not disable the
required policy to roll back a protected deployment. Preserve the database and
use a policy-compatible image; otherwise keep protected writes unavailable.

## Tests

The focused test uses an isolated PostgreSQL database with disposable fixture
credentials. Set `PGHOST` to its host and run:

```sh
node --test --test-force-exit test/mutations/atomic.cjs
```

The explicit exit handles background timers loaded by core modules. Assertions
await their transactions and deferred effects. The test covers real adapter
rollback, cache isolation, replay concurrency, receipt failure, unsupported
backends, plugin removal, guarded core and API entrypoints, moderation-history
storage keys, and direct/bulk storage paths.
The ordinary database and forum suites must also pass with enforcement unset.
