#!/bin/sh
# Auto-Voice-Channels — Discord status patch. TOG-3143.
#
# WHAT THIS IS, for anyone who reaches it through an AGPL-3.0 §13 source offer:
# this script, together with upstream Auto-Voice-Channels at commit
# 8fab5e8d78aa252195dcea1bcd3d313cb1ba0802, IS the modified version we run. It is
# the complete and only change we make to that program. Nothing else in our
# deployment alters upstream's code.
#
# WHAT IT DOES. Upstream renders its Discord presence from a hardcoded module
# constant — at the pinned commit, `bot/src/gateway/client.ts:17`:
#
#     const SETUP_STATUS = 'auto-voice.io · /setup';
#
# applied at gateway identify through `ClientOptions.presence` as an
# `ActivityType.Custom` activity. There is no environment variable and no
# database setting for it. This script rewrites that constant in the compiled
# output before starting the bot, then execs the command it was given.
#
# WHY AT START-TIME rather than at build time: the image stays byte-identical to
# a stock build of the pinned commit, so the pin remains an honest description of
# what we build, and we need no Dockerfile of our own duplicating upstream's
# multi-stage build. It runs on every container start, so it is a redeploy —
# not just a restart — that cannot revert it. That is the whole point.
#
# It is idempotent: a second run detects the constant is already what we want and
# does nothing.
#
# Environment:
#   AVC_STATUS_TEXT     the status to set. EMPTY OR UNSET disables the patch
#                       entirely and runs upstream verbatim, advert and all.
#   AVC_STATUS_ENFORCE  `strict` (default) = refuse to start if the constant is
#                       not found exactly once. `warn` = log and start anyway
#                       with upstream's status.
#   AVC_STATUS_TARGET   the compiled file to rewrite. Defaults to the path inside
#                       upstream's image; overridden by the tests.
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

# The patch itself is JavaScript because the edit is a JavaScript string literal:
# JSON.stringify is the only quoting that is correct for every text the owner
# might pick on TOG-3142. Doing it in sed would be a quoting bug waiting to
# happen. `node` is present because this runs inside upstream's own node image.
#
# Reads its settings from the environment directly, so this file passes nothing
# through and there is no second place for a default to drift.
node -e '
const fs = require("node:fs");
const target = process.env.AVC_STATUS_TARGET || "/app/bot/dist/gateway/client.js";
const text = process.env.AVC_STATUS_TEXT || "";
const strict = (process.env.AVC_STATUS_ENFORCE || "strict") !== "warn";
const fail = (msg) => { console.error("[avc-status] " + msg); process.exit(strict ? 1 : 0); };
if (text === "") { console.error("[avc-status] AVC_STATUS_TEXT is empty - leaving upstream status in place"); process.exit(0); }
if (Array.from(text).length > 128) fail("AVC_STATUS_TEXT is longer than the 128-character Discord limit");
let src = "";
try { src = fs.readFileSync(target, "utf8"); } catch (err) { fail("cannot read " + target + ": " + err.message); }
const anchor = () => new RegExp("^const SETUP_STATUS = .*;", "gm");
const hits = src.match(anchor()) || [];
if (hits.length !== 1) fail("expected exactly 1 SETUP_STATUS declaration in " + target + ", found " + hits.length + " - the upstream pin has moved, re-derive this patch before deploying");
const line = "const SETUP_STATUS = " + JSON.stringify(text) + ";";
if (hits[0] === line) { console.log("[avc-status] already applied"); process.exit(0); }
fs.writeFileSync(target, src.replace(anchor(), () => line));
console.log("[avc-status] bot status set to " + JSON.stringify(text));
'

# `set -e` above is what makes this fail closed: a non-zero exit from the patch
# never reaches here, so the bot does not start with the advert still in place.
exec "$@"
