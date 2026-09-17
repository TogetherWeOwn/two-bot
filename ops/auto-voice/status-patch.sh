#!/bin/sh
# Auto-Voice-Channels — Discord presence patch. TOG-3143.
#
# WHAT THIS IS, for anyone who reaches it through an AGPL-3.0 §13 source offer:
# this script, together with upstream Auto-Voice-Channels at commit
# 8fab5e8d78aa252195dcea1bcd3d313cb1ba0802, IS the modified version we run. It is
# the complete and only change we make to that program. Nothing else in our
# deployment alters upstream's code.
#
# WHAT IT DOES. Upstream sets a Discord presence at gateway identify from two
# hardcoded lines. At the pinned commit, `bot/src/gateway/client.ts`:
#
#     17:  const SETUP_STATUS = 'auto-voice.io · /setup';
#     50:  activities: [{ type: ActivityType.Custom, name: SETUP_STATUS, state: SETUP_STATUS }],
#
# There is no environment variable and no database setting for either, and
# nothing re-applies a presence later — `setPresence`/`setActivity` have zero
# hits in the tree, so identify is the only source. This script rewrites those
# lines in the compiled output before starting the bot, then execs the command it
# was given.
#
# It has an anchor on BOTH lines deliberately. Rewriting only the string can
# change the status but can never REMOVE it — `activities: []` is not reachable
# from any value of the text — and removal is what was actually asked for.
#
# WHY AT START-TIME rather than at build time: the image stays byte-identical to
# a stock build of the pinned commit, so the pin remains an honest description of
# what we build, and we need no Dockerfile of our own duplicating upstream's
# multi-stage build. It runs on every container start, so it is a redeploy —
# not just a restart — that cannot revert it. That is the whole point.
#
# It is idempotent, and safe in both directions: each mode converges, and a mode
# switched on an existing writable layer repairs what the other mode wrote.
#
# Environment:
#   AVC_STATUS_MODE     `none` (DEFAULT) = no custom status at all; the presence
#                       activities array is emptied.
#                       `text` = keep a custom status, with AVC_STATUS_TEXT as
#                       its text.
#                       `upstream` = do not patch; run upstream verbatim, advert
#                       and all.
#   AVC_STATUS_TEXT     the status text. Required and non-empty when MODE=text;
#                       must be unset or empty otherwise.
#   AVC_STATUS_ENFORCE  `strict` (default) = refuse to start if an anchor is not
#                       found exactly once. `warn` = log and start anyway with
#                       upstream's presence. This covers upstream MOVING; it is
#                       not an escape hatch for a bad MODE/TEXT pair, which is
#                       our own misconfiguration and always fails hard.
#   AVC_STATUS_TARGET   the compiled file to rewrite. Defaults to the path inside
#                       upstream's image; overridden by the tests.
#
# THE DEFAULT IS REMOVAL. With no AVC_* variable set at all this yields "no
# custom status", which is the state that was asked for. A deployment that
# forgets to pass any environment gets the wanted behaviour, not the advert.
#
# Usage: status-patch.sh <command> [args...]      e.g. `node bot/dist/index.js`
#
# Tested by ./test-status-patch.sh, which runs THIS file.
set -eu

if [ "$#" -eq 0 ]; then
  echo "[avc-status] no command given - nothing to start after patching." >&2
  echo "[avc-status] usage: status-patch.sh <command> [args...]" >&2
  exit 1
fi

# The patch itself is JavaScript because the edits are JavaScript source:
# JSON.stringify is the only quoting that is correct for every text the owner
# might pick. Doing it in sed would be a quoting bug waiting to happen. `node` is
# present because this runs inside upstream's own node image.
#
# Reads its settings from the environment directly, so this file passes nothing
# through and there is no second place for a default to drift.
node -e '
const fs = require("node:fs");
const target = process.env.AVC_STATUS_TARGET || "/app/bot/dist/gateway/client.js";
const mode = process.env.AVC_STATUS_MODE || "none";
const text = process.env.AVC_STATUS_TEXT || "";
const strict = (process.env.AVC_STATUS_ENFORCE || "strict") !== "warn";
const log = (m) => console.log("[avc-status] " + m);
// `fail` is for upstream having MOVED - that is what AVC_STATUS_ENFORCE=warn
// exists to survive. `die` is for our own configuration being wrong, which warn
// mode must not paper over: booting the advert because someone typo-ed a mode is
// exactly the silent regression this card exists to stop.
const fail = (m) => { console.error("[avc-status] " + m); process.exit(strict ? 1 : 0); };
const die = (m) => { console.error("[avc-status] " + m); process.exit(1); };

if (mode !== "none" && mode !== "text" && mode !== "upstream")
  die("AVC_STATUS_MODE must be none|text|upstream, got " + JSON.stringify(mode));
if (mode === "upstream") {
  log("AVC_STATUS_MODE=upstream - leaving upstream presence in place, advert and all");
  process.exit(0);
}
if (mode === "none" && text !== "")
  die("AVC_STATUS_MODE=none removes the status entirely, but AVC_STATUS_TEXT is set to "
      + JSON.stringify(text) + " - set AVC_STATUS_MODE=text if you want that text");
if (mode === "text" && text === "")
  die("AVC_STATUS_MODE=text needs a non-empty AVC_STATUS_TEXT");
if (mode === "text" && Array.from(text).length > 128)
  die("AVC_STATUS_TEXT is longer than the 128-character Discord limit");

let src = "";
try { src = fs.readFileSync(target, "utf8"); } catch (err) { fail("cannot read " + target + ": " + err.message); }

// Fresh RegExp per use: /g objects carry lastIndex between calls.
const CONST = () => new RegExp("^const SETUP_STATUS = .*;$", "gm");
const ACTIVITIES = () => new RegExp("^[ \\t]*activities: \\[.*\\],$", "gm");
const only = (re, what) => {
  const hits = src.match(re) || [];
  if (hits.length !== 1)
    fail("expected exactly 1 " + what + " in " + target + ", found " + hits.length
         + " - the upstream pin has moved, re-derive this patch before deploying");
  return hits[0];
};
const indentOf = (line) => line.match(/^[ \t]*/)[0];
// Upstream`s own activity, restated. Only ever written to REPAIR an array a
// previous MODE=none run on this same writable layer emptied.
const upstreamActivity = (indent) =>
  indent + "activities: [{ type: ActivityType.Custom, name: SETUP_STATUS, state: SETUP_STATUS }],";

if (mode === "none") {
  // Only the activities anchor is required here. The SETUP_STATUS constant may
  // survive as dead data - it renders nothing once the array is empty, and
  // demanding it would fail a deploy that is otherwise entirely correct.
  const actLine = only(ACTIVITIES(), "presence `activities:` line");
  const want = indentOf(actLine) + "activities: [],";
  if (actLine === want) { log("already applied - no custom status"); process.exit(0); }
  fs.writeFileSync(target, src.replace(ACTIVITIES(), () => want));
  log("custom status removed - presence activities set to []");
  process.exit(0);
}

// mode === "text"
const constLine = only(CONST(), "SETUP_STATUS declaration");
const actLine = only(ACTIVITIES(), "presence `activities:` line");
const wantConst = "const SETUP_STATUS = " + JSON.stringify(text) + ";";
let out = src;
let changed = false;
if (constLine !== wantConst) { out = out.replace(CONST(), () => wantConst); changed = true; }
if (actLine.indexOf("SETUP_STATUS") === -1) {
  // The array no longer renders the constant, so setting the text alone would
  // show nothing. Restore upstream`s activity.
  out = out.replace(ACTIVITIES(), () => upstreamActivity(indentOf(actLine)));
  changed = true;
  log("restored the presence activity that an earlier AVC_STATUS_MODE=none run emptied");
}
if (!changed) { log("already applied - status is " + JSON.stringify(text)); process.exit(0); }
fs.writeFileSync(target, out);
log("bot status set to " + JSON.stringify(text));
'

# `set -e` above is what makes this fail closed: a non-zero exit from the patch
# never reaches here, so the bot does not start with the advert still in place.
exec "$@"
