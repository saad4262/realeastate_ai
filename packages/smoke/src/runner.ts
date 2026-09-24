/**
 * A tiny check runner.
 *
 * Deliberately not vitest: these run against the live database, the live
 * Google account and whatever dev servers happen to be up. They are not unit
 * tests and must never be confused with them — a red unit test means the code
 * is wrong, a red check here often means something outside the code is.
 */

export type Status = 'pass' | 'fail' | 'skip' | 'info';

export type Result = {
  group: string;
  name: string;
  status: Status;
  /** Why it failed, or what it found. One line. */
  detail?: string;
};

const results: Result[] = [];
let currentGroup = 'general';

export function group(name: string): void {
  currentGroup = name;
}

/** Thrown by a check to report a skip rather than a failure. */
export class Skip extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Skip';
  }
}

export function skip(reason: string): never {
  throw new Skip(reason);
}

/**
 * Run one check.
 *
 * A check returns a string to say what it found — that line is printed on
 * success too, because "passed" on its own tells you nothing about a system
 * whose data changes between runs.
 */
export async function check(
  name: string,
  fn: () => Promise<string | void> | string | void,
): Promise<void> {
  try {
    const detail = await fn();
    results.push({
      group: currentGroup,
      name,
      status: 'pass',
      ...(detail ? { detail } : {}),
    });
  } catch (err) {
    if (err instanceof Skip || (err as Error)?.name === 'Skip') {
      results.push({ group: currentGroup, name, status: 'skip', detail: (err as Error).message });
      return;
    }
    results.push({
      group: currentGroup,
      name,
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** A finding that is neither pass nor fail — a missing optional key, say. */
export function note(name: string, detail: string): void {
  results.push({ group: currentGroup, name, status: 'info', detail });
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const MARK: Record<Status, string> = {
  pass: '\u001b[32m✓\u001b[0m',
  fail: '\u001b[31m✗\u001b[0m',
  skip: '\u001b[90m–\u001b[0m',
  info: '\u001b[36mi\u001b[0m',
};

/**
 * Print everything and return the process exit code.
 *
 * Only `fail` is fatal. A skip is usually a dev server that is not running, and
 * failing the whole run for that would train everyone to ignore the output.
 */
export function report(): number {
  let lastGroup = '';
  for (const r of results) {
    if (r.group !== lastGroup) {
      process.stdout.write(`\n\u001b[1m${r.group}\u001b[0m\n`);
      lastGroup = r.group;
    }
    const detail = r.detail ? `  \u001b[90m${r.detail}\u001b[0m` : '';
    process.stdout.write(`  ${MARK[r.status]} ${r.name}${detail}\n`);
  }

  const count = (s: Status) => results.filter((r) => r.status === s).length;
  const failed = count('fail');

  process.stdout.write(
    `\n${count('pass')} passed, ${failed} failed, ${count('skip')} skipped, ${count('info')} notes\n`,
  );

  if (failed) {
    process.stdout.write('\n\u001b[31mFailures:\u001b[0m\n');
    for (const r of results.filter((x) => x.status === 'fail')) {
      process.stdout.write(`  ${r.group} › ${r.name}\n      ${r.detail}\n`);
    }
  }

  return failed ? 1 : 0;
}
