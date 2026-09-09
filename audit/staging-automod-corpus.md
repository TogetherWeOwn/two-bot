# TWO Staging automod corpus

Guild: `1545644954272137297`
Application: `Owen QA Test` (`1469137636663758888`)

Fresh read-only export on 2026-09-09 found one enabled native Discord rule: mention spam at 20 mentions with mention-raid protection. `staging-automod-rules-2026-09-09.json` is the exact response.

The custom engine is default-off. Before a live-guild rollout, run this corpus only in TWO Staging with a disposable, unprotected QA member. Configure an explicit test bad phrase that is not real abusive content, an allowed domain, one external domain, one blocked extension, one bypass role, and one exempt channel.

| Row | Trigger | Expected filter | Expected action | False-positive control |
|---|---|---|---|---|
| 1 | Ordinary sentence | none | message remains | baseline |
| 2 | Configured test bad phrase as whole words, including zero-width splitting | `bad_words` | delete | phrase embedded inside a larger word remains |
| 3 | Same non-empty message three times inside 30 seconds | `repeated_message` | delete/warn/timeout by count | two repeats remain |
| 4 | Five explicit user mentions, including five repeats of one user | `mention_spam` | ladder action | four mentions remain; an implicit reply reference does not count |
| 5 | Discord invite URL, including zero-width host splitting | `invite_link` | ladder action | plain text `discord` remains |
| 6 | URL outside allowlist, including bare `example.net` and zero-width host splitting | `external_link` | ladder action | allowed bare/angled/punctuated `two.gg` links and email addresses remain |
| 7 | Attachment ending in configured blocked extension | `attachment_type` | ladder action | `.png` remains |
| 8 | Any trigger from bypass role | none | message remains | same trigger without role is blocked |
| 9 | Any trigger in exempt channel | none | message remains | same trigger in general is blocked |
| 10 | Edit allowed message into a trigger | matching filter | ladder action | edit to allowed text remains |
| 11 | Replay the same gateway message id | stored result | no second Discord mutation or violation | audit count unchanged |
| 12 | Protected staff target reaches warn/timeout rung | moderation refusal | message delete may occur; sanction refused and logged | ordinary QA member receives sanction |

Reconcile each positive row to one `automod.<filter>` audit row containing message id, filter, violation count, sanction, timeout seconds, and dry-run flag. The row must contain no content or matched excerpt. Warn/timeout rungs must also produce the reviewed moderation audit/warning rows from the TOG-1642 path.
