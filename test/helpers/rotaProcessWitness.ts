// Test-only spies: delegate unchanged, report completed work through IPC.
// No actor/message bodies, keys, tokens, or database URLs enter diagnostics.
import { DiscordOnboardingRota } from '../../src/discord/onboardingRota.ts';
import { OnboardingRota } from '../../src/analytics/onboardingRota.ts';
import { CommunityClassifier } from '../../src/analytics/communityClassifier.ts';
import { RotaNoticeDelivery } from '../../src/discord/rotaNoticeDelivery.ts';

const completed: Record<string, number> = {};
const pending = new Set<Promise<unknown>>();
let failures = 0;
const classifications: Record<string, number> = {};
function spy(prototype: object, method: string, label: string) {
  const original = Object.getOwnPropertyDescriptor(prototype, method)!;
  Object.defineProperty(prototype, method, {
    ...original,
    value: new Proxy(original.value, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        const settled = Promise.resolve(result).then(() => {
          completed[label] = (completed[label] ?? 0) + 1;
        }, () => { failures++; });
        pending.add(settled);
        void settled.finally(() => pending.delete(settled));
        return result;
      },
    }),
  });
}
for (const method of ['join', 'gateCleared', 'promptShown', 'message']) {
  spy(DiscordOnboardingRota.prototype, method, `observer.${method}`);
}
for (const method of ['rulesAccepted', 'promptShown', 'message']) {
  spy(OnboardingRota.prototype, method, `core.${method}`);
}
spy(RotaNoticeDelivery.prototype, 'runDue', 'delivery.runDue');
const classify = CommunityClassifier.prototype.classify;
CommunityClassifier.prototype.classify = function (input) {
  const result = classify.call(this, input);
  classifications[result.classification] = (classifications[result.classification] ?? 0) + 1;
  return result;
};
process.on('message', async (message: { command?: string; id?: number }) => {
  if (message.command !== 'snapshot') return;
  // Wait for the real per-subject queues, not an arbitrary sleep then zero rows.
  while (pending.size) await Promise.all([...pending]);
  process.send?.({ kind: 'witness', id: message.id, completed, classifications, failures });
});
