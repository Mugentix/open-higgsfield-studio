/* The windows the spend report answers for. On its own, with no imports, so
   the team dialog can read the same list the action validates against: the
   report module pulls the database driver in, and a value import of it would
   drag that into the client bundle. */

export const SPEND_PERIODS = [7, 30, 90] as const;
export type SpendDays = (typeof SPEND_PERIODS)[number];
export const DEFAULT_SPEND_DAYS: SpendDays = 30;

export function isSpendDays(value: unknown): value is SpendDays {
  return (SPEND_PERIODS as readonly unknown[]).includes(value);
}
