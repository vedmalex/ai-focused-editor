/**
 * The assertion vocabulary the runner-agnostic contract cores are written in
 * (TASK-022 WP-3, extracted in WP-4a when a second contract core arrived).
 *
 * HAND-ROLLED, AND FOR ONE REASON: a contract case must be executable by BOTH
 * `bun:test` and the `node:test` runner, so it may not import `expect` from
 * either. These functions throw; each harness turns a throw into its own idea
 * of a failure.
 *
 * DELIBERATELY NOT EXPORTED FROM THE PACKAGE BARREL. `check` and `equal` are
 * exactly the names a consumer would collide with, and nothing outside the two
 * contract cores has any business calling them.
 */

export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractViolation';
  }
}

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ContractViolation(message);
  }
}

export function equal<T>(actual: T, expected: T, what: string): void {
  if (!Object.is(actual, expected)) {
    throw new ContractViolation(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * Serialize with sorted keys.
 *
 * KEY ORDER IS NOT PART OF THE CONTRACT and must not be asserted by accident.
 * The in-memory adapter returns a structural clone of what it was handed, so it
 * preserves the literal's key order; the SQLite adapter rebuilds the object
 * column by column and cannot. A plain `JSON.stringify` comparison would fail
 * for SQLite on that difference alone — a red test with nothing wrong behind it,
 * which is worse than no test because it teaches people to weaken the assertion.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function deepEqual(actual: unknown, expected: unknown, what: string): void {
  const a = stableStringify(actual);
  const b = stableStringify(expected);
  if (a !== b) {
    throw new ContractViolation(`${what}: expected ${b}, got ${a}`);
  }
}

/**
 * Assert that `body` throws the store port's error with the given kind.
 *
 * The KIND is asserted, never the message: the in-memory adapter phrases its
 * refusal itself while SQLite's text comes from the engine, and an assertion on
 * wording would be an assertion about which adapter is running.
 */
export async function rejectsWithKind(
  body: () => unknown,
  kind: string,
  what: string,
  isPortError: (error: unknown) => error is { kind: string }
): Promise<void> {
  let threw: unknown;
  let returned = false;
  try {
    await body();
    returned = true;
  } catch (error) {
    threw = error;
  }
  check(!returned, `${what}: expected a rejection, but the call returned normally`);
  check(
    isPortError(threw) ? threw.kind === kind : false,
    `${what}: expected an error of kind '${kind}', got ${String(threw)}`
  );
}

/** As {@link rejectsWithKind}, but the rejection may come from the ENGINE rather
 *  than from the port — a SQLite `CHECK` throws its own `Error`. What is
 *  asserted is only that the call did not succeed. */
export async function rejectsSomehow(body: () => unknown, what: string): Promise<void> {
  let returned = false;
  try {
    await body();
    returned = true;
  } catch {
    return;
  }
  check(!returned, `${what}: expected a rejection, but the call returned normally`);
}
