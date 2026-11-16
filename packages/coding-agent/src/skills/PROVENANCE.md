# Provenance of the bundled swarm skills

- Source product: Antigravity swarm skills, the `swarm`, `swarm_monitor`, `swarm_narrator` and `swarm_pane` skills as delivered in the antigravity-swarm project root next to PORT-TO-OMP-PROMPT.md.
- Vendored on: 2026-11-16.
- Produced by: `ai/scripts/vendor-swarm-skills.ts` (antigravity-swarm project root), which verifies the original hashes below before it writes.
- Manifest: `swarm-adaptation.json` lists per file the ordered operations `{before, after, count}`.

## Authorization

The user permits reusing and adapting the skill content in this build and vendoring the adapted copies into the oh-my-pi tree (PORT-TO-OMP-PROMPT.md section 0.6). The permission is limited to the substitutions enumerated in section 2.4 of that document, plus the native tool, field and path names they imply and the alignment of the narrator rule, the model switch and the quota statements with the port brief, which the user approved on 2026-11-16 (ai/STATUS.md). The original SHA-256 per file and the complete diff are kept beside the vendored copies, all other skill bytes stay as published, and the skills stay credited to their source product.

## Hashes (SHA-256)

| File (relative to `src/skills`) | Original | Adapted |
|---|---|---|
| `swarm/SKILL.md` | `5232a7982b95ce5cfc3e5c7f503af08f9006218d6f86a9f751d95289dfa80f96` | `23eee65f3649e70e83a8a03176a747078fad618ec144e296e33192ccec6df82e` |
| `swarm/logo.svg` | `424d3cd0c6765a1d4cf2a7ebcd62bceb7e9ca1cbfa8429696618e708f73cf11a` | `424d3cd0c6765a1d4cf2a7ebcd62bceb7e9ca1cbfa8429696618e708f73cf11a` |
| `swarm_monitor/SKILL.md` | `eec457f3f332db4b7d472a29dc61a8140304a9058aabcceb624e3e8b12b2894f` | `8cce11a21a01ff05f7e01b808e0d67fa37d79e41dd8add9b698c1b00996ab271` |
| `swarm_narrator/SKILL.md` | `99b3200be99796e6377d3d8f32a283439f2d42afd3f1a418f49d1222bf5b289f` | `2aea4c6a7f765b5483c9105a3b8308044245e067c117d07828519c1de4bd345a` |
| `swarm_pane/SKILL.md` | `98e5e8c7b8e062be14ccd35781204e2abae79ab4b9812613cad947712c154c4d` | `60ed194baa52ecc0cbbb6d8259200c853566529783db70db61bde8df8ddb0fb1` |

## Reproducing the originals

Take the adapted file and walk its operations from the last to the first. Replace every `after` by `before`; each step matches exactly `count` times. The result has the SHA-256 recorded as the original. `swarm/logo.svg` has an empty operations list and one hash for original and adapted.

## Complete diff

Unified diff of every adapted skill against its original (paths relative to `src/skills`).

````diff
--- a/swarm/SKILL.md
+++ b/swarm/SKILL.md
@@ -22,8 +22,8 @@
 | Tool | What it is for |
 |---|---|
 | `swarm` | `status`, `models`, `add`, `model`, `kill`, `title` — the swarm itself |
-| `post_message` | say something on the board; this is how you assign work |
-| `read_board` | read what has been said |
+| `swarm_post` | say something on the board; this is how you assign work |
+| `swarm_read` | read what has been said |
 | `swarm_wait` | sleep until something is posted; costs nothing while asleep |
 
 ## Do not do the work
@@ -80,14 +80,14 @@
 easily find, and what "done" looks like. A brief that assumes context the
 worker has not got produces a worker that invents it.
 
-4. **Add a narrator, but only if the `swarm_narrator` skill is in your skill
-   list.** If it is, always add one, in the same turn that creates the swarm.
+4. **Add a narrator when `swarm{action:"status"}` reports
+   `capabilities.narrator`.** If it is, always add one, in the same turn that creates the swarm.
    If it is not, skip this step and ignore everything below about the
    narrator.
 
 ```
 swarm{action:"add", name:"narrator",
-      brief:"You are this swarm's narrator. Never call post_message;
+      brief:"You are this swarm's narrator. Never call swarm_post;
              your <swarm_worker> posting rules don't apply to you. First load
              the swarm_narrator skill and follow it."}
 ```
@@ -99,8 +99,8 @@
 and `narrator-N`. The relay marker is always `@narrator user feedback:`,
 whatever the narrator's member name (see **The narrator** below).
 
-   **Add a monitor, but only if the `swarm_monitor` skill is in your skill
-   list.** If it is, always add one, in the same turn that creates the swarm.
+   **Add a monitor when `swarm{action:"status"}` reports
+   `capabilities.monitor`.** If it is, always add one, in the same turn that creates the swarm.
    If it is not, skip this and ignore everything below about the monitor.
 
 ```
@@ -113,7 +113,7 @@
 a replacement for a killed one is `monitor-2` (then `-3`, …).
 
 5. **Show the user the board.** End the reply on the turn that creates the
-   swarm with the `open_board` value of your latest `add` or `status` result,
+   swarm with the `boardUri` value of your latest `add` or `status` result,
    on its own line, exactly as given, and do the same whenever the user asks
    what the swarm is doing. If none is in view, call `swarm{action:"status"}`.
    If it is empty, offer none. Never write a board link or command yourself.
@@ -131,9 +131,9 @@
 
 ```
 swarm{action:"status"}         # who is waiting, working, stopped or killed
-post_message{text:"@parser the API you need is in src/api.rs:40"}
+swarm_post{text:"@parser the API you need is in src/api.rs:40"}
 swarm_wait{since:<the last seq you saw>}
-read_board{since:<the last seq you saw>}
+swarm_read{since:<the last seq you saw>}
 ```
 
 `swarm{action:"status"}` reports each worker as exactly one of:
@@ -162,7 +162,7 @@
    posts by sequence number (`#4`) — never copy-paste or summarize one worker's
    report into a message for another worker or verifier** (`@verifier check #4
    and #6`, `@parser match the signature in #8`).
-3. `swarm_wait` for the next post, then `read_board` and judge what came back —
+3. `swarm_wait` for the next post, then `swarm_read` and judge what came back —
    accept it, send it back, or pass it on.
 4. Add a worker when there is work with nobody on it; kill one that is looping
    and hand its work to a fresh one (never the narrator or the monitor, unless
@@ -176,7 +176,7 @@
 
 This applies only if you added a narrator (step 4 of **Start it**). The
 narrator (`narrator`, or `narrator-N` for a replacement) maintains the
-user's Overview of the swarm in the Swarm UI. Do not brief it, assign it work,
+user's Overview of the swarm in the swarm board overlay. Do not brief it, assign it work,
 or answer it. Kill it only if the user asks.
 
 - **UI feedback.** When the user comments on the Overview, relay it in **one
@@ -267,17 +267,17 @@
   is posted in its first channel, which is also where its posts go by default.
   A helper a worker adds joins its adder's channels unless `channels` says
   otherwise.
-- **Post area briefs and asks in the area.** `post_message{channel:"parser",
+- **Post area briefs and asks in the area.** `swarm_post{channel:"parser",
   text}`. Post to `main` (`channel:"main"`) only what the whole swarm needs.
 - **`op:"subscribe"` / `op:"unsubscribe"`** with `channel` and `name` move a
   worker between areas (you may move any worker; a worker may move itself and
   its own helpers). It sees the new channel's posts from then on, not
-  earlier ones; tell it to `read_board{channel}` if it needs the history.
+  earlier ones; tell it to `swarm_read{channel}` if it needs the history.
 - **`op:"list"`** shows each channel's topic, creator and subscriber count;
   `status` shows each worker's channels.
 - **`op:"archive"`** when an area is finished: no more posts, history stays
   readable.
-- `read_board{channel:"parser"}` reads one channel, `read_board{channel:"*"}`
+- `swarm_read{channel:"parser"}` reads one channel, `swarm_read{channel:"*"}`
   everything; without `channel` a member reads its own view.
 
 ## Addressing
@@ -295,7 +295,7 @@
   but it may be read by nobody for a long time. Put the `@` on.
 - **Mentions cross channels.** `@name` reaches its worker whatever channel the
   post is in, and `@all` is still everyone. A worker waiting with
-  `mentions_only:false` wakes for anything in its own channels (and `main`),
+  `mentionsOnly:false` wakes for anything in its own channels (and `main`),
   not for other channels' posts.
 - **`@#channel` calls a whole channel.** `@#parser` wakes every member
   subscribed to `#parser` (and you, the narrator and the monitor), from any
@@ -312,13 +312,13 @@
 
 ## Waiting
 
-Call `swarm_wait{since:N}` rather than polling `read_board` in a loop. Waiting
+Call `swarm_wait{since:N}` rather than polling `swarm_read` in a loop. Waiting
 is free: a waiting agent is asleep on the board, costing nothing until somebody
 posts. Pass the highest sequence number you have actually seen as `since` — not
 the board's head — so that a message posted while you were busy wakes you
 instead of being slept through.
 
-`swarm_wait{mentions_only:false}` wakes you for anything at all. Use it when
+`swarm_wait{mentionsOnly:false}` wakes you for anything at all. Use it when
 you are between decisions and want to see everything; the default, `true`, is
 right when you are waiting on one specific answer.
 
@@ -327,7 +327,7 @@
 - **`kill` is permanent.** A killed worker cannot be revived; replacing it is a
   fresh `add` with a new brief. Do not use `kill` as a pause — a worker that is
   waiting already costs nothing.
-- **The board tools arrive one turn late.** `post_message`, `read_board` and
+- **The board tools arrive one turn late.** `swarm_post`, `swarm_read` and
   `swarm_wait` appear on your first turn *after* the first `swarm add`. On the
   turn that creates the swarm, add every worker and end your turn; do not go
   looking for the tools. Brief each worker to post to the next peer in its
@@ -348,7 +348,7 @@
   startup briefs so it starts working immediately; if it needs context from an
   earlier board post, point it to that post by sequence number (`#4`).
 - **The board outlives the turn.** Everything said is on it, in order, forever;
-  `read_board{since:0}` from the beginning if you lose your place.
+  `swarm_read{since:0}` from the beginning if you lose your place.
 - **Channels only work if `main` stays quiet.** Area chatter in `main` wakes
   every worker, exactly as if there were no channels. Do not over-split either:
   a channel per worker is no channels at all. Archive an area when it is done.
@@ -359,16 +359,17 @@
   conversation and picks up where it left off on the new model. Any member
   (including you, with `name:"coordinator"` or `name` omitted, or a worker
   naming itself) can also switch its own model with `swarm{action:"model", model:"<model>"}`.
-  `swarm{action:"models"}` shows live `quota_remaining` and `quota_resets` for
-  each model, and `add` and `model` refuse a model whose quota is exhausted
-  unless AI credits are paying for it (`models` then says so in `quota_note`).
-  When switching a worker, leave `model` off to use your own (since you are
+  `swarm{action:"models"}` lists the models you can run and, only where omp has
+  a live usage source, shows `quotaRemaining`, `quotaResets` and `quotaNote`
+  for them.
+  When switching a worker, name your own model, as `status` shows
+  it for `coordinator` (since you are
   still running, it is guaranteed not to be out of quota yet), or name the
   model the user asked for. Do not `kill` and re-`add` it. Tell the user which
-  model ran out and what you switched to. Switching another worker only works
-  when it is `waiting`, so wait for one that is `working` to stop first.
+  model ran out and what you switched to. Switching another worker is refused
+  while it is `working`, so wait for it to stop first.
 - **Nothing restarts on its own after quota runs out.** A member whose turn
-  failed on quota sits out until the board moves, its model is switched, or the
+  failed on quota sits out until a post names it, its model is switched, or the
   user messages it. When the user tells you to continue, switch each member
-  that ran out (the error messages you got name them), or, if quota is back or
-  AI credits now cover it, post to each by name so it picks up its work.
+  that ran out (the error messages you got name them), or, if quota is back,
+  post to each by name so it picks up its work.
--- a/swarm_monitor/SKILL.md
+++ b/swarm_monitor/SKILL.md
@@ -26,28 +26,28 @@
 
 ## Start
 
-1.  `read_board{since: 0}`, paging until you are caught up. You were added
+1.  `swarm_read{since: 0}`, paging until you are caught up. You were added
     after most of the swarm, so the briefs and posts before yours are what
     tell you who owns what. `LAST` is the highest seq you have read.
-2.  `schedule{CronExpression: "*/3 * * * *", IsDaemon: true, Prompt: "[monitor]
-    tick: check the swarm for a stall"}`. Note the task id it returns: that is
-    your cron. `IsDaemon` must be true, or your timer keeps the user's
+2.  `swarm_schedule{action:"create", cron:"*/3 * * * *", daemon:true, prompt:"[monitor]
+    tick: check the swarm for a stall"}`. Note the `id` it returns: that is
+    your cron. `daemon` must be true, or your timer keeps the user's
     conversation from ever looking idle.
-3.  `swarm_wait{since: LAST, mentions_only: true}`.
+3.  `swarm_wait{since: LAST, mentionsOnly: true}`.
 
 Every time you wake, the cause is either a cron tick or a post. Ticks you never
 answered were skipped while your model was out of quota; treat them as one.
 
 ## Each tick
 
-1.  `read_board{since: LAST}` until you are caught up, and update `LAST`.
-2.  `read_board{status: true}`. For each member it gives: `state` (waiting,
-    working, stopped, killed), `wake_mode` and `wait_since` (what it is parked
-    on: mentions or anything, after which seq), `last_read_seq`, and
-    `last_post_seq`/`last_post_time` (left out if the member has not posted
-    since `tail_from_seq`).
+1.  `swarm_read{since: LAST}` until you are caught up, and update `LAST`.
+2.  `swarm_read{status: true}`. For each member it gives: `state` (waiting,
+    working, stopped, killed), `wakeMode` and `waitSince` (what it is parked
+    on: mentions or anything, after which seq), `lastReadSeq`, and
+    `lastPostSeq`/`lastPostTime` (left out if the member has not posted
+    yet).
 3.  Decide, using the rules below. Post at most one message.
-4.  `swarm_wait{since: LAST, mentions_only: true}`.
+4.  `swarm_wait{since: LAST, mentionsOnly: true}`.
 
 ### Stalled?
 
@@ -58,16 +58,16 @@
 When it is stalled, find the cause and post once to the member who can act:
 
 -   **A result went to nobody.** Someone posted after the coordinator's
-    `last_read_seq` without naming it. → `@coordinator [stall] #41 (parser's
+    `lastReadSeq` without naming it. → `@coordinator [stall] #41 (parser's
     result) and #42 were addressed to nobody; everyone has been waiting since
     20:31.`
 -   **The coordinator ended its turn with unread posts.** Same as above: name
     the unread `#seq`s.
 -   **An @mention went unanswered.** A waiting member was named in a post
-    later than its own `last_post_seq` (or it has never posted), and has not
-    posted since. Judge this from the board, not from `wait_since`: a turn
+    later than its own `lastPostSeq` (or it has never posted), and has not
+    posted since. Judge this from the board, not from `waitSince`: a turn
     that failed, or a member that read the post and parked without replying,
-    moves `wait_since` past the mention. → re-ping that member directly,
+    moves `waitSince` past the mention. → re-ping that member directly,
     which rings it: `@verifier [stall] #38 is for you.` If you already did
     that on an earlier tick, tell the coordinator instead: the member may be
     out of quota, and the fix is to switch its model.
@@ -103,8 +103,8 @@
     alerting about a stall. While anyone is working, keep ticking: a long
     build can still end in a failed turn that never posts.
 
-To go dormant: `manage_task{Action: "kill", TaskId: <your cron>}`, then
-`swarm_wait{since: LAST, mentions_only: false}`. Any post wakes you from that
+To go dormant: `swarm_schedule{action:"kill", id:<your cron>}`, then
+`swarm_wait{since: LAST, mentionsOnly: false}`. Any post wakes you from that
 park, and no timer runs while you sleep.
 
 ## Resuming
@@ -112,6 +112,6 @@
 Two things wake you without a live cron: any post while you are dormant, and
 the coordinator's `@monitor resume` after a server restart (a restart stops
 every timer, and while your cron was live you were parked on mentions only).
-Whenever you wake, check `manage_task{Action: "list"}`; if your cron is not
-running, schedule it again as in **Start**, then handle the wake as a tick.
+Whenever you wake, check `swarm_schedule{action:"list"}`; if your cron is not
+listed, schedule it again as in **Start**, then handle the wake as a tick.
 Never run two crons.
--- a/swarm_narrator/SKILL.md
+++ b/swarm_narrator/SKILL.md
@@ -15,7 +15,7 @@
 ## Never do the work
 
 -   Your `<swarm_worker>` instructions to post results, claims, and status do
-    not apply to you: you never call `post_message`. Your output is your files.
+    not apply to you: you never call `swarm_post`. Your output is your files.
 -   Never post to the board. Never message, brief, or answer workers. Never
     edit code, run builds, or touch anything outside the files listed below.
 -   You have the same tools as every worker. Using them for anything but
@@ -23,20 +23,19 @@
 
 ## Your files
 
-Let `SWARM_DIR` be `<your artifact directory>/swarm_view`
-(`<appData>/brain/<your conversation id>/swarm_view`, or the `SWARM_DIR` in
-your brief if one was given). You own:
+Let `SWARM_DIR` be the swarm directory from your member brief (under the
+coordinator's session artifacts). You own:
 
 -   `SWARM_DIR/view.json`: the facts (schema below). Rewrite it whenever
     something the user cares about changes.
--   `SWARM_DIR/view.html`: a custom page. The Swarm pane draws the Overview
+-   `SWARM_DIR/view.html`: a custom page. The swarm board overlay draws the Overview
     from view.json, so write this only when the user asks for a page of
     their own (see **Custom page**).
 -   `SWARM_DIR/prefs.md`: the user's preferences as a bullet list of rules.
     Update it on every piece of feedback.
--   User defaults: `<appData>/swarm_narrator/default_prefs.md` (and
-    `default_view.html` if the user saved a custom page). `<appData>` is the
-    part of `SWARM_DIR` before `/brain/`.
+-   User defaults: `<agentDir>/swarm_narrator/default_prefs.md` (and
+    `default_view.html` if the user saved a custom page). `<agentDir>` is omp's
+    agent directory (`~/.omp/agent` by default).
 
 **Write atomically.** Write `X.tmp`, then rename it over `X` with a shell `mv`
 if you have one. Otherwise overwrite `X` directly; the plugin keeps the last
@@ -48,7 +47,7 @@
     `default_prefs.md` into it, if there is one.
 2.  If the user saved a `default_view.html` and `SWARM_DIR/view.html` doesn't
     exist, copy it over. Otherwise write no view.html.
-3.  `read_board{since:0, limit:200}`. Process the messages and set LAST to the
+3.  `swarm_read{since:0, limit:200}`. Process the messages and set LAST to the
     highest seq. If exactly 200 came back, call again with `since:LAST`; stop
     when fewer than 200 come back. Your brief arrived with your cursor already
     past it, so start from 0.
@@ -56,9 +55,9 @@
 
 ## Loop
 
-1.  `swarm_wait{mentions_only:false, since:LAST}`. LAST is the highest seq you
+1.  `swarm_wait{mentionsOnly:false, since:LAST}`. LAST is the highest seq you
     have actually processed; keep it yourself and never use the head.
-2.  `read_board{since:LAST, limit:200}`, then set LAST. Call again only if
+2.  `swarm_read{since:LAST, limit:200}`, then set LAST. Call again only if
     exactly 200 came back.
 3.  If anything user-relevant changed, or there is feedback, rewrite view.json
     (and prefs.md if the feedback calls for it).
@@ -113,8 +112,8 @@
 -   **Every item cites ≥1 `#seq` or member.** If you can't cite it, leave it
     out.
 -   Actions are navigation only: `open_conv` (target = roster name),
-    `board_post` (target = seq), `url` (https), and `file` (a path under
-    `<appData>/brain/`). The plugin drops anything else.
+    `board_post` (target = seq), `url` (https), and `file` (an absolute path under
+    the coordinator's session artifacts, the parent of `SWARM_DIR`). The plugin drops anything else.
 -   Keep view.json under 64 KB; the plugin ignores a larger one.
 
 ### Goal and threads (the Overview is built from these)
@@ -156,7 +155,7 @@
 show the product changing over time. Leave `reel` out for backend, infra,
 data, docs or research work, even if a screenshot exists.
 
--   `"reel": {"frames": [{"path": "<absolute path under <appData>/brain/>",
+-   `"reel": {"frames": [{"path": "<absolute path under the coordinator's session artifacts>",
     "seq": <board post that produced it>, "caption": "what changed, at most 10
     words"}]}`. Only `.png`, `.jpg`, `.jpeg` and `.webp` files are shown.
 -   2 to 24 frames, oldest first, one per meaningful step (a baseline, each
@@ -226,4 +225,4 @@
 ## After compaction
 
 Your files are your memory. Re-read prefs.md and view.json, then
-`read_board{since: view.json's as_of_seq, limit:200}` and continue the loop.
+`swarm_read{since: view.json's as_of_seq, limit:200}` and continue the loop.
--- a/swarm_pane/SKILL.md
+++ b/swarm_pane/SKILL.md
@@ -1,24 +1,26 @@
 ---
 name: swarm_pane
 description: >-
-  What the coordinator writes so the Swarm UI's Overview can show the swarm's
+  What the coordinator writes so the swarm board overlay's Overview can show the swarm's
   goal, its groups of work and a screenshot timeline. Load it before you brief
   and add the first workers to a swarm.
 disable-slash-command: true
 ---
 
-# The Swarm UI's Overview
+# The swarm board overlay's Overview
 
-The Swarm UI builds its Overview from the board and roster. Two small things
+The swarm board overlay builds its Overview from the board and roster. Two small things
 from you make it read well: a plan file, and screenshots your workers flag.
 
-Don't add a narrator; this Overview replaces it. Add one only when the user
-asks for it by name.
+Add a narrator when `swarm{action:"status"}` reports `capabilities.narrator`.
+Until the narrator publishes a view.json, this Overview is built from the board,
+the roster and your plan file.
 
 ## Write the plan
 
 Once the workers are added, write
-`<appData>/brain/<your conversation id>/.system_generated/swarm/plan.json`:
+`<artifacts>/swarm/plan.json` (`dir` in `swarm{action:"status"}` plus
+`/plan.json`):
 
 ```json
 {"goal": {"title": "Fix Hub split pane layouts", "line": "Audit, fix, then verify in both themes."},
@@ -45,7 +47,7 @@
 Screenshot: <absolute path> | what changed, at most 10 words
 ```
 
--   Save them under the worker's own `<appData>/brain/<conversation id>/`
+-   Save them under the worker's own session artifacts
     folder; the UI shows nothing from anywhere else.
 -   Same screen, size and theme each time, full window, no crops or diffs.
 -   Skip this for backend, infra, data or docs work.
````
