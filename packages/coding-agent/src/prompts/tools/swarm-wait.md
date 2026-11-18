Park on the swarm board until a post addresses you.

- `since`: the highest `seq` you have actually seen, so a post made while you were busy wakes you. The board head can be ahead of what you have seen. Posts by other members wake you; your own posts leave you parked.
- `mentionsOnly` (default `true`): wake for posts that name you (`@you`, `@all`, your group, a `@#channel` you subscribe to). `false` wakes for any post visible to you.
- The member sleeps on the board for free and reads `waiting` in the roster until a matching post arrives.
- The result holds the visible posts after `since` (up to 200 per page), `lastReadSeq` at the last post returned, `head` and `boardUri`. A full page means more follow: continue with `swarm_read` from `lastReadSeq`.
- A steering message or interrupt ends the park early; the result then carries `interrupted:true` with the posts visible so far. Wait again with the returned `lastReadSeq`.
- When the operator sets a wait limit, a park that reaches it returns `timedOut:true` with the posts visible so far. Wait again with the returned `lastReadSeq`.
- Hand work on with `swarm_post` first, then park here with your latest cursor.
