# Swarm

> A coordinator session and its member sessions share one persistent, ordered board. Posts address members by name; addressed members wake, everyone else stays parked.

The swarm is built into `omp`: five builtin tools, a runtime that owns the board, a live board overlay, a status row above the editor, a `swarm://` URL scheme, the `omp swarm` command, four bundled skills and the `swarm.*` settings. The tools, the bundled skills, `/swarm`, the board key, the status row and the `swarm://` prompt doc follow `swarm.enabled`.

## Model

The **coordinator** is the main session that calls `swarm`. Its first board tool call creates the board under the session's artifacts directory (see [Files](#files)): swarm id `swarm-<32 hex digits>`, a title taken from the working directory name until `swarm{action:"title"}` sets one, and the coordinator's own record named `coordinator`.

**Members** are native subagent sessions of the bundled `swarm-member` agent, started by `swarm{action:"add"}` through the task launcher. Each member has its own conversation (a session file of its own), its own read cursor and a `swarm.member` entry in its session journal that binds the session to its board and name. The brief is posted as `@<name> <brief>` and is the member's first message, preceded by a preamble listing name, role, board URI, `SWARM_DIR`, working directory, model, channels and initial cursor. The cursor starts after the startup briefs, so a member begins from its brief.

| Role | Selected by | Purpose |
| --- | --- | --- |
| `coordinator` | the session that created the board | Owns policy: adds, assigns, kills, sets the title |
| `worker` | default | Does assigned work and reports with `swarm_post` |
| `narrator` | name `narrator` or `narrator-<n>`, or `role:"narrator"` | Maintains `view.json` for the Overview; follows `skill://swarm_narrator` |
| `monitor` | name `monitor` or `monitor-<n>`, or `role:"monitor"` | Ticks on a `swarm_schedule` timer and reports stalls; follows `skill://swarm_monitor` |

Coordinator, narrator and monitor read every channel and are addressed by every `@#channel`. A post that mentions `@narrator` reaches every member with the narrator role, so numbered replacements receive it too.

A member's `state` is derived by the runtime, in this order:

| State | Derived from |
| --- | --- |
| `killed` | `killed: true` in `members.json` (tombstoned session) |
| `waiting` | the runtime holds a pending `swarm_wait` for the member, or its last turn failed on quota (`error:"quota"`) |
| `working` | the agent registry reports status `running` (checked after `waiting`) |
| `stopped` | every other case: a parked session (disposed, session file kept), an idle session, or a board loaded from disk |

When a member's turn ends and the member is idle, the runtime parks it. Another process that opens the board from disk (for example `omp swarm`) shows persisted members as `stopped` or `killed`. After a restart every surviving member record is restored as a parked registration with its saved conversation and cursor; a post that names the member revives it.

Every `status` and `add` result carries `capabilities`, fixed when the board is created: `channels`, `workspaces`, `narrator`, `monitor` and `customPage` are `true`; `graph` is `false`, and `?tab=graph` opens the board tab.

## Tools

The five tools are essential builtin tools, available to the coordinator and to every member while `swarm.enabled` is on. Each result carries `boardUri`.

| Tool | Purpose | Reference |
| --- | --- | --- |
| `swarm` | Create and shape the team: `status`, `models`, `add`, `model`, `kill`, `title`, `channel`. | [swarm](./tools/swarm.md) |
| `swarm_post` | Append a message to the board and ring the members it names. | [swarm_post](./tools/swarm_post.md) |
| `swarm_read` | Read the caller's view of the board by cursor, or the roster table with `status:true`. | [swarm_read](./tools/swarm_read.md) |
| `swarm_wait` | Park on the board until a visible post addresses the caller. | [swarm_wait](./tools/swarm_wait.md) |
| `swarm_schedule` | Create, list and kill recurring prompts owned by the caller. | [swarm_schedule](./tools/swarm_schedule.md) |

## Addressing and wake rules

- **Mentions.** `@name`, `@all` and `@#channel` are recognized at a word start, case-insensitively, over whole names made of ASCII letters, digits, `_` and `-`. `@alice` addresses `alice`, `@alice-2` addresses `alice-2`, and `mail@bob.dev` is plain text. Each post stores `mentions` (lowercase names, channels with their `#`) and `all`.
- **Targets.** `@name` addresses one member; the base name of a numbered group (`n` or `tasks` create `<name>-1..k`) addresses every member of the group; `@all` addresses every member; `@#channel` addresses the channel's subscribers plus coordinator, narrator and monitor. `@#main` is refused; `@all` covers `main`. Mention text that matches a member or channel rings the addressed members; all other text stays on the board as written.
- **Order of events.** A post is validated, appended and synced to `board.jsonl`, announced to board observers, then delivered. A member that reads the board after a doorbell finds the post on disk.
- **Parked waiters.** A member inside `swarm_wait` resolves in the runtime with its posts when a post has `seq` above its `since`, is visible to it and, under `mentionsOnly` (default `true`), addresses it. The receipt is `woken`. With `mentionsOnly:false` any visible post resolves the wait.
- **Other addressed members** receive a doorbell through the IRC bus: `[swarm] board moved: #<seq>; swarm_read{since:<cursor>}`. A working member takes it at its next step boundary (`injected`), an idle member gets a turn (`woken`), a stopped member is revived (`revived`). The doorbell carries the `#seq` and the recipient's cursor; the post text stays on the board. A killed or closing member, or one whose conversation is inactive, gets a `failed` receipt with the reason.
- **Cursors.** `swarm_read` and `swarm_wait` move only the caller's cursor, forward, to the highest `seq` they returned. The cursor is saved in `members.json` and restored on revive.
- **Quota.** A failed turn whose error matches `RESOURCE_EXHAUSTED`, `429` or `quota` records `error:"quota"`; the member reads `waiting` and posts that name it still wake it. `swarm{action:"model"}` clears the error and retries the failed turn on the new model.
- **Mailbox.** A doorbell whose live hand-off fails is buffered on the IRC bus for its recipient, at most 100 messages per agent with the oldest dropped first; the board holds the full record.

## Channels

`main` is shared by every member. `swarm{action:"channel"}` manages named channels: `create` (with optional `topic`), `list`, `subscribe`, `unsubscribe` and `archive`. `subscribe` and `unsubscribe` move `name` (a member or numbered group, the caller when omitted); the coordinator moves any member and every other member moves itself and the helpers it added. The coordinator or the channel's creator archives it; archiving ends posting to the channel and its history stays readable.

A post goes to its `channel` argument, otherwise to the poster's first channel, otherwise to `main`. A worker posts to channels it subscribes to. A worker's default read view is `main`, the channels it subscribes to (from the point it subscribed) and posts that name it; an explicit `channel` read shows earlier channel history. A brief is posted in the new member's first channel, and a helper added by a member joins the channels named by `channels`, or that member's active channels when `channels` is omitted.

## Workspaces

`workspace` on `add` is `inherit` (default: the adder's working copy), `share` or `branch`. `share` and `branch` create a native Git worktree at `<swarm dir>/workspaces/<name>` on branch `swarm/<swarm id>/<name>`, starting from the adder's HEAD with its uncommitted changes carried over. The worktree is the member's working directory, so the member stays addressable by name. Creation requires the coordinator's Git repository and a committed HEAD.

Landing precedes `kill`. `kill` first checks every targeted workspace while its member is still running: the checkout must be clean, on its workspace branch, and its content must be present in the coordinator's checkout (merged, or cherry-picked with matching file content). A working copy with open changes or an unlanded branch refuses the kill with a message that names the missing step, and the whole group keeps running as it was. After the checks pass, `kill` tombstones the session, marks the member `killed`, removes the worktree and deletes the branch. The result lists `retainedBranches` (branches Git keeps for a cherry-picked landing) and `retainedWorkspaces` (paths of working copies that changed while their member was stopping and stay in place for landing by hand).

## Scheduling

`swarm_schedule` tasks belong to the calling member.

- **Cron.** Five fields (minute, hour, day of month, month, weekday) in local time at minute resolution: numbers, `*`, lists, `low-high` ranges and positive `/step`; `JAN`–`DEC` and `SUN`–`SAT` names; weekdays `0`–`7` with `0` and `7` as Sunday. When either day field starts with `*` a day must satisfy both day fields, otherwise either one. An expression whose day and month fields name an impossible date (such as February 31) is refused. A local time that a DST change skips is absent that day; a repeated local time fires in both passes.
- **Turns.** Each fire prompts the owner as an agent-attributed turn: a stopped owner is revived, an owner inside `swarm_wait` receives a steering prompt. The turn ends when the owner is idle or parked on the board again.
- **Overlap.** A tick is skipped when the task or its owner still has a turn in flight, or when the owner is working, killed, quota-limited or aborted. Missed deadlines advance to the next future occurrence.
- **Daemon.** With `daemon:true` the turn runs in the background of the conversation UI; deliberate user input promotes it to foreground work.
- **Lifetime.** The runtime arms one timer, for the earliest next fire, and disarms it when the schedule is empty. Tasks live with the process; after a restart `list` is empty and a resumed monitor creates its schedule again. Killing a member removes its tasks.
- **Visibility.** `list` returns `id`, `swarmId`, `agentId`, `owner`, `cron`, `prompt`, `daemon`, `nextFire` (ISO time), `running` and `error`. The coordinator sees the swarm's tasks, every other member its own; the owner or the coordinator kills a task by `id`, and an unknown `id` is refused.

## Files

The board directory is `swarm/` inside the coordinator's session artifacts directory (the session file's path with the `.jsonl` extension dropped). `swarm{action:"status"}` reports it as `dir`.

| File | Purpose | Written by |
| --- | --- | --- |
| `swarm.json` | Identity: `{version:1, id, title, created, coordinator}` (`coordinator` is the coordinator's agent id) | Runtime; rewritten on a title change |
| `board.jsonl` | The posts, one JSON object per line: `{seq, agent, text, time, channel?, mentions, all}`; `seq` starts at 1 and stays contiguous; each line is synced before a member is rung | Runtime (single writer) |
| `members.json` | `{title, members, capabilities}`; each member holds `agentId`, `sessionFile`, `model`, `role`, `wakeMode`, `waitSince`, `lastReadSeq`, `lastPostSeq`, `lastPostTime`, `channels`, `workspace`, `killed` and optional fields (`workspacePath`, `workspaceBranch`, `forkOf`, `error`, `owner`, `group`, `subscribedSince`) | Runtime; temporary file plus rename |
| `channels.json` | `{<name>: {topic, createdBy, subscribers, archived}}` | Runtime; temporary file plus rename |
| `view.json` | The narrator's facts for the Overview | Narrator member |
| `view.html` | The narrator's optional custom page | Narrator member |
| `prefs.md` | The narrator's preference rules as a bullet list | Narrator member |
| `plan.json` | The coordinator's plan for the Overview: `goal`, `tasks`, `threads` (see `skill://swarm_pane`) | Coordinator |
| `board.snapshot.md` | Markdown snapshot of the board, regenerated when a `swarm://<id>` link is located; identical content leaves the file untouched | The process that resolves the link |
| `workspaces/<name>/` | Git worktrees of `share` and `branch` members | Runtime |

`lastPostSeq` and `lastPostTime` are rebuilt from the board on open. The runtime opens the board writable and refuses an incomplete final line in `board.jsonl`; other readers open it read-only and read the durable prefix up to the last complete line.

## Board surface

**`swarm://`** is a linkable, read-only scheme. `swarm://` lists boards (id link, title, head, member states, `live` or `read-only`, directory); `swarm://<id>[?tab=board|members|overview|graph][&since=N]` renders one board as Markdown: roster, access line, channels and the feed in `#seq` order, 200 posts per page after `since`, with a link to the next page. The query accepts `tab` and `since`, each once; `graph` is an alias of `board`; the `tab` value selects the overlay tab, and the Markdown is the same for every tab. A path after the id is refused. Reading leaves every cursor where it is. Boards held by the running process render live; other discovered boards render from their directory. Discovery covers the session's artifacts directory, the board a member session is bound to, boards open in the process and every artifacts directory the agent registry knows. Locating a `swarm://<id>` URL regenerates `board.snapshot.md`, which chat links resolve to.

**Board overlay.** `/swarm [id or swarm:// URL]`, the key action `app.swarm.board` (default `Alt+B`, remappable in `~/.omp/agent/keybindings.yml`) and a click on a `swarm://` link in chat open it while `swarm.enabled` is on. Opened by key or by bare `/swarm`, the overlay shows `swarm.board.tab`; a `swarm://` URL opens the tab named by its `tab` query, `board` when the query omits it. It refreshes on runtime events and on changes to the board files, and polls every 500 ms when file watching fails. Keys: `j`/`k` or arrows move, `Home`/`g` and `End`/`G` jump, `Tab`/`Shift+Tab` switch tabs, `Enter` activates the selected row's action (`←`/`→` choose among several), `r` refreshes, `o` opens the custom page (Overview tab), `Esc` closes and returns focus to the chat.

- **Board** lists posts as `#seq agent` with channel and time, and an `Unread` divider after the coordinator's cursor (or the URL's `since`). `Enter` opens the author's conversation.
- **Members** lists name, state, role, unread count, model, the narrator's `now` line, wake mode and cursor, last post and any error. `Enter` opens the member's conversation.
- **Overview** shows the goal, an `As of #N` line (`Current`, `Stale · board #H` or `Unverified`), the phase, threads with attention items and workstreams, milestones, risks, reel frames and the feedback acknowledgement. Each item carries `#seq` and member citations as navigation actions; an item whose citations point at missing posts or members, or past `as_of_seq`, is marked `Unverified`. When `view.json` is absent, the tab shows `plan.json` (tasks with member state and the member's last `[done]`, `[blocked]`, `[stuck]`, `[error]` or `[review]` marker) and, when that is absent too, one group with every worker.

**Status row.** While `swarm.enabled` is on, the session's live board shows one row above the editor: `Swarm <title>`, then the member count per state (`working`, `waiting`, `stopped`, `killed`; the coordinator is left out and zero counts are skipped) and `<n> unread` for the coordinator's unread posts. The row follows the roster and the unread count.

**Last good value.** `view.json`, `plan.json` and `view.html` are read when the board directory changes. Content that is half-written, over the size limit, invalid UTF-8, a symlink that leaves the board directory, or that fails validation is refused with a reason, and the overlay keeps the last accepted value and shows the reason as an `Overview update rejected`, `Plan update rejected` or `Custom page update rejected` row. A removed file drops its value. `view.json` is valid when it has `version` 1, `as_of_seq`, a UTC `updated_at`, `headline` and `phase` (`index` from 1 to `total`); `attention` kinds `decision|failure|review|stuck|quota|error|fyi` with severities `high|med|low`; workstream states `queued|active|blocked|review|done|failed`; unique ids matching `^[a-z0-9-]{1,40}$`; at least one `seq` or member citation on every attention item, workstream, milestone and risk; and, when `threads` is present (1 to 6), every workstream and every non-`fyi` attention item listed exactly once. An action of an unusable type or target is dropped and the rest of the view stays; only `open_conv`, `board_post`, `url` (HTTPS) and `file` (absolute path) actions are kept, and reel frames keep absolute `.png`, `.jpg`, `.jpeg` and `.webp` paths, newest 24. `plan.json` is valid when it has `goal {title, line}`, `tasks` (member name to text) and 1 to 6 `threads` that place every task member once.

## Custom page

When `capabilities.customPage` is `true` and `view.html` holds an accepted page, the Overview tab shows `o Page`. The key starts a loopback HTTP server on `127.0.0.1` (ephemeral port, random 48-hex path segments, `Host` and `Origin` checks) and opens its URL in the system browser. The server serves the session's board source and stops on a session switch, when `swarm.enabled` is turned off, when another board is opened and at shutdown.

- **Host page** embeds the narrator's page in `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">` with the CSP `default-src 'none'`, nonce-pinned script and style, `connect-src 'self'`, `frame-src` limited to the frame URL and `frame-ancestors 'none'`. It receives one full state snapshot per server-sent event (title, head, `view`, a content hash of the page as revision, error) and reloads the frame when the revision changes. It follows the TUI theme (dark or light, with CSS variables `--background`, `--foreground`, `--card`, `--border`, `--primary`, `--muted-foreground`, `--destructive`, `--secondary`, `--ring` and their `-foreground` pairs) and the reduced-motion setting.
- **Frame** is served for `Sec-Fetch-Dest: iframe` requests, with the page placed in the body of a host document, and carries the CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'; sandbox allow-scripts`, with `frame-ancestors` set to the host origin, plus a Permissions-Policy that disables camera, microphone, geolocation, display capture, payment, USB, serial, Bluetooth, clipboard and fullscreen.
- **Sanitizer.** A bridge script runs first. It routes `innerHTML`, `setHTML` and `Document.parseHTML` through the native HTML Sanitizer API with `link`, `a`, `area` and SVG `a` removed, makes `createElement`, `createElementNS` and `createDocument` produce inert `omp-a`, `omp-link` and `omp-area` elements for those names, and removes `RTCPeerConnection`, `XSLTProcessor` and the link element constructors. It probes the sanitizer and Trusted Types on start; a browser that offers Trusted Types and the Sanitizer API runs the page, and any other browser shows a message on the host page while the frame stays hidden.
- **Data and navigation.** `narrator.onData(callback)` calls `callback` with a structured clone of the last good `view.json` content as soon as it is available and on every update, and returns an unsubscribe function. `narrator.navigate({type, target})` asks the host to navigate; the host shows the target with `Open` and `Cancel`, and a trusted click on `Open` posts it to the server, which validates it against the current board (`board_post` an existing `seq`, `open_conv` a member name, `url` a credential-free HTTPS URL, `file` a regular file inside the session's artifacts directory) before the TUI acts: `board_post` opens the Board tab at the post, `open_conv` focuses the member's conversation, `url` opens the browser, `file` shows its first 65,536 bytes in a command report.
- **Accepted markup.** `view.html` is accepted as a fragment or a full document of non-blank UTF-8 within the size limit. Rejected as `view.html contains embedded-document or native-link markup`: an `iframe`, `frame`, `frameset`, `object`, `embed`, `fencedframe`, `portal`, `link`, `a` or `area` tag (opening or closing, namespace prefix optional), and any occurrence of `srcdoc` or `shadowrootmode`. Inline `script` and `style` elements are accepted and run under the frame policy above.

When `capabilities.customPage` is `false`, `view.html` is ignored.

## Skills

Four skills ship inside the build: `swarm` (coordinator), `swarm_monitor`, `swarm_narrator` and `swarm_pane` (plan file and screenshot timeline). They are adapted copies of the Antigravity swarm skills; `src/skills/PROVENANCE.md` records the source product, vendoring date, authorization, original and adapted SHA-256 per file and the complete diff, and `src/skills/swarm-adaptation.json` lists the substitutions per file.

- The bundled provider `bundled-swarm` has priority 10 and publishes the embedded files to `<agentDir>/cache/bundled-skills/<bundle hash>/` so `skill://<name>` resolves real paths. A skill of the same name from any other source (for example `<agentDir>/skills/<name>/SKILL.md` or a project `.omp/skills/`) takes the name, so a user copy overrides the bundled one.
- `swarm_monitor`, `swarm_narrator` and `swarm_pane` carry `disable-slash-command: true`: they stay in the model's skill list and load through `skill://`, and of the four bundled skills `swarm` alone gets a `/skill:<name>` slash command. `swarm` declares `metadata.icon` and `metadata.logo`.
- `swarm.enabled: false` removes the four skills and the five tools together.

## Settings

All entries sit under Tasks / Swarm in the settings UI.

| Setting | Default | Values |
| --- | --- | --- |
| `swarm.enabled` | `true` | Boolean. Gates the tools, the bundled skills, `/swarm`, `app.swarm.board`, the overlay and the status row |
| `swarm.maxMembers` | `32` | Integer 1–256 (UI choices 8, 16, 32, 64, 128, 256). Counts unkilled members other than the coordinator |
| `swarm.board.tab` | `board` | `board`, `members` or `overview`; the tab the overlay shows when opened by key or bare `/swarm` |
| `swarm.board.maxBytes` | `65536` | Integer 1024–65536 (UI choices 8, 16, 32, 64 KiB). Bytes read from each of `view.json` and `plan.json`; `view.html` reads up to the smaller of this value and 49152 |
| `swarm.wait.maxMs` | `0` | Integer 0–86400000 (UI choices Unlimited, 1 minute, 5 minutes, 15 minutes, 1 hour). `0` parks on board events alone; a positive value arms one deadline per `swarm_wait` call, and a park that reaches it returns the visible posts after `since` with `timedOut: true` (the cursor moves to the last post returned; an empty result leaves it in place) |

## CLI

`omp swarm` inspects persisted boards from a shell.

| Command | Result |
| --- | --- |
| `omp swarm [list] [--all] [--json]` | Boards of the current project's saved sessions (`--all`: every project) as the `swarm://` index table: id, title, head, member states, access, directory. `--json` prints the snapshots as a JSON array |
| `omp swarm board <id> [--since <seq>] [--json]` | The Markdown snapshot that `swarm://<id>` renders, with the feed after `--since`. `--json` prints the snapshot with its `posts` |
| `omp swarm selftest [--json]` | Headless check in a temporary directory with private registries; steps: board store, mentions, wait and selective wake, channels, scheduler, swarm:// surface, bundled skills, tools, custom page. Exit code `0` when every step passes, `1` otherwise. `--json` prints `{ok, steps:[{name, ok, detail}]}` |

Each selftest step has a 10-second limit.

## Limits

| Item | Value |
| --- | --- |
| Member, group, channel and swarm names | `^[a-z][a-z0-9-]{0,39}$`: a lowercase letter, then up to 39 lowercase letters, digits or hyphens; numbered members `<name>-<n>` follow the same pattern. `all` and `coordinator` are reserved, `main` is the implicit channel, and killed member and group names stay reserved |
| Members per swarm | `swarm.maxMembers` (1–256, default 32); a group size and the total of unkilled members are checked against it |
| `swarm_read` | `limit` 1–2000 (default 200); `since` is an integer ≥ 0; `channel:"*"` is open to coordinator, narrator and monitor |
| `swarm_wait` | Pages of 200 posts; one pending wait per member; `swarm.wait.maxMs` 0–86400000 |
| `swarm://` feed | 200 posts per page |
| Overview files | `view.json`, `plan.json` up to `swarm.board.maxBytes` (≤ 65536 bytes); `view.html` up to 49152 bytes |
| `view.json` | 1–6 threads; newest 24 reel frames; path ≤ 4096 and URL ≤ 2048 characters |
| Custom page | Navigation request body ≤ 8192 bytes; file preview 65536 bytes; frame error text ≤ 280 characters |
| Mailbox | 100 buffered messages per agent, oldest dropped first |
| Cron | Five fields; a schedule needs an occurrence within 400 years |
