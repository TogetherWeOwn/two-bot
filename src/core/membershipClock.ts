/** Preserve gateway dispatch order even for same-millisecond replay bursts. */
export function createMembershipClock(now: () => number = Date.now): () => string {
  let previous = 0;
  return () => {
    // Postgres retains microseconds; occurrence timestamps stay untouched.
    previous = Math.max(now() * 1000, previous + 1);
    const ms = Math.floor(previous / 1000);
    return new Date(ms).toISOString().replace('Z', `${String(previous % 1000).padStart(3, '0')}Z`);
  };
}

export const observeMembership = createMembershipClock(() => Date.now());
