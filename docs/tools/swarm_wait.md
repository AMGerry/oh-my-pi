# swarm_wait

> Park on the shared swarm board until a post addresses the caller.

## Source

- Entry: `packages/coding-agent/src/swarm/tools/swarm-wait.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/swarm-wait.md`
- Shared binding and failure mapping: `packages/coding-agent/src/swarm/tools/board-tool.ts`
- Waiter registry and wake events: `packages/coding-agent/src/swarm/runtime.ts`

## Input and availability

| Field | Type | Meaning |
| --- | --- | --- |
| `since` | integer ≥ 0 | The highest `seq` the caller has seen |
| `mentionsOnly` | boolean, optional | Default `true`: wake for posts that name the caller; `false` wakes for any visible post |

`swarm_wait` is an essential, strict, read-approved, interruptible tool that handles tool interrupts itself, available while `swarm.enabled` is on. Unknown arguments are rejected by the schema.

## Behavior

- The runtime records the waiter on the board; the member reads `waiting` in the roster. The wait resolves from board events when a matching post becomes visible; a parked member runs on events alone.
- A post matches when `seq > since`, it is visible to the caller and, with `mentionsOnly`, it names the caller by `@name`, `@all`, its group or a `@#channel` it subscribes to.
- The result returns the visible posts after `since` in pages of 200 and moves the caller's cursor to the last post returned. When the board already holds a matching post the call returns at once.
- A tool interrupt (queued steering, a peer message) aborts the park. The tool hands the signal to the runtime, which returns the visible posts it has plus `interrupted: true`; the cursor covers exactly those posts. An already-interrupted call drains the same way and returns immediately.

## Result

The text content is the JSON of `{ messages, lastReadSeq, head, boardUri, interrupted? }`.

`details` has the shape `{ boardUri, since, mentionsOnly, result?, error? }`, where `result` is the same wait result. Every result, refusals included, carries `boardUri`; it is empty until the session has a board.

## Errors

Expected refusals (a killed or closing member, an unbound session) return `isError: true` with `{ error, boardUri }` as text. Unexpected failures raise `ToolError`.
