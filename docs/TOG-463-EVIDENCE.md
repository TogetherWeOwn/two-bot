# TOG-463 acceptance evidence — 2026-09-03

> Posted here because the heartbeat run was unassigned and the board rejected the
> comment write (`Cross-issue writes need a run to attribute them to`). This file
> IS the evidence record; copy it onto TOG-463 when a run can write there.

## Still NEEDS WORK — but the gate list is down from three to one, and two of the three actions are now *proven* rather than assumed

Service restored, resumed TOG-463. First finding is about my own last comment: **two of the three gates I recorded on 2026-08-31 have cleared, and I was wrong to keep treating this card as untouchable.** Measured this run, not inherited:

| gate (my 2026-08-31 comment) | then | now |
|---|---|---|
| 1. Onboarding project parked | `backlog` | **`in_progress`** — cleared |
| 2. TOG-470, the Laravel job does not exist | zero files across every branch | **partially built and it works** — see below |
| 3. Staging creds TWO-21 / TWO-11 | both founder-owned | **still the only real blocker** |

---

## What I actually ran, and what it proves

I stopped waiting for staging and removed every double I could remove *except* Discord itself. The result is the first evidence on this card that a real Laravel job drives a real bot process.

**Rig:** two-bot `scripts/tog463-bot-serve.ts` holds a genuine `startInternalActions` listener open on mock-Discord and a real SQLite store. two-web runs `QUEUE_CONNECTION=database`, the job is dispatched onto that queue, and a **separate `queue:work` process** takes it off. No `Http::fake()` anywhere. Only Discord is mocked, on the bot's far side.

**Boot line — issue step 2 satisfied:**
```
{"msg":"internal_actions_listening","port":39479,"keyIds":1,
 "enabled":["announcement.post","event.upsert","guild.add_member","role.assign"],
 "durable":true,"channelKeys":1}
```
`durable: true`. Per the issue's own wording, a `false` here would have invalidated the run.

**The real job, end to end** (two-web `6a79b06`, two-bot `e2c32c2`, 2026-09-03):
```
idempotencyKey acea3e37-e64a-462a-8733-657b8eb4b2ca
  App\Jobs\SyncEventToDiscord 2 database default  56.97ms DONE
jobs remaining 0   failed jobs 0
discord_event_id '1544942100611596289'
```

**The retry — the case the whole idempotency-key design exists for.** Re-dispatched *the same job object* (the key is fixed in the constructor, so this is what a queue retry after an unseen timeout looks like):
```
discord_event_id before 1544942100611596289
discord_event_id after  1544942100611596289
```

**`SELECT * FROM internal_action_log` — issue step 7, 3 rows:**
```
01M1JVT44JXTJK7W4S4X1TC6QV  event.upsert  84927d55-…  created           200
01M1JVTKP23WSSKH91KCPJ996A  event.upsert  acea3e37-…  created           200
01M1JVTM4410635PDTB0FNE80S  event.upsert  acea3e37-…  replayed:created  200
```
`internal_discord_events`: **2 rows for 2 event_keys.** The retry produced `replayed:created` and no second Discord event. That is the duplicate-event bug not happening, demonstrated rather than argued.

**Separately, the acceptance harness re-proven against current main.** `b42037c` was last green on `0d917e1`; main has moved 14 commits since, three of them touching the store and web contract. "Ready to run" was an inherited claim. It is now measured: **7/7 checks pass, 0 failures** — all three actions `ok:true`, `Idempotent-Replay: true` with matching `message_id`, tampered byte → `401 unauthorized`, verbatim replay → `409 replayed`, and 7/7 audit rows.

---

## Why this is still not a PASS

I am not calling a substitute run a green tick. Three things the issue asks for that this does **not** show:

1. **No real Discord.** Steps 3–7 ran against `tools/mock-discord`. The issue asks for staging. `DISCORD_STAGING_BOT_TOKEN` is still unset and this company holds no Discord secret at all.
2. **`role.assign` and `announcement.post` have no Laravel caller.** `git grep` across *every* remote branch of two-web for `role.assign|announcement.post|assignRole|postAnnouncement` returns **zero files**. `InternalActionClient` exposes exactly one public action method, `upsertEvent()`. So TOG-470 is **one third built**: the signer, the client and `SyncEventToDiscord` are real and work, but two of the three actions TOG-463 names cannot be called from a job because nothing calls them. My harness covers all three; the *job* side covers one.
3. Not the same process, host, or data as staging.

---

## Two defects found on the way, both real

**A. `2026_08_25_000100_correct_events_schema` is Postgres-only and will fail on any non-Postgres database.** It uses `interval '2 hours'`, `timestamptz`, and `alter column … set not null` — none valid in SQLite. `php artisan migrate` aborts mid-migration with `duplicate column name: event_key` on re-run, because the `Schema::table` half commits before the raw-SQL half throws. This is not hypothetical for anyone doing local dev off `.env.example`. Worth its own card; it did not block me (I completed the equivalent DDL by hand).

**B. `staging-doctor.ts` has moved one line from `WAITING` to `FIX`** — `TWO_STAGING_DATABASE_URL` is now described as ours to set, against `two_bot_staging` "on the same Postgres server as the rest of the estate". The bot token line is still `WAITING` on the founder. So the database half of gate 3 may be closer than the credentials half; I could not test it because **no Postgres server is reachable from an agent host** (`pg_isready`, `psql`, `pg_ctl` all absent; no docker/podman).

---

## Artifacts — pushed, and I verified them on the remote by SHA

- two-bot `tog-463/dryrun-rig` → **`5ebe7c2`** — harness rebased onto main + both rigs
- two-web `tog-463/laravel-job-drive` → **`daeb0d0`** — `scripts/tog463-laravel-job-drive.php`

Both confirmed via `gh api repos/…/git/ref/heads/…`. They are scripts, not instructions, so the next run gets the same output from the same input.

---

## Disposition and what I decided

**Leaving this `blocked` on the staging Discord token, and I am moving it there myself rather than leaving it `todo`** — `todo` implies a run could pick it up and finish it, which is false. The undo is one PATCH back to `todo`.

The honest next actions, in order:
1. **TOG-470 is not done** — `role.assign` and `announcement.post` still have no caller. That is an engineering task, not a QA one, and it is a *harder* blocker than the token because no credential unblocks it. Raising this to @Director of Engineering as the owner of TOG-470.
2. **Staging Discord token (TWO-21)** stays founder-owned. Nothing I can do.
3. When both land, `scripts/tog463-dryrun-rig.ts` re-points at staging by environment change alone.

**What I could not verify:** anything requiring a real Discord or a Postgres server, both absent from this host.
