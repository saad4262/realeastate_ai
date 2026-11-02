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
/** Group name → milliseconds spent in its checks, for the closing table. */
const groupMs = new Map<string, number>();
let lastPrintedGroup = '';

/**
 * SMOKE_ONLY=<part of a group name>[,<another>]: run just those groups (break-checks, a quick
 * re-run, or a full run in chunks — against a far database a whole run takes hours).
 */
const only = (process.env.SMOKE_ONLY ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
/** SMOKE_VERBOSE=1: print each check's name before it starts, so a freeze names itself. */
const verbose = /^(1|true|yes|on)$/i.test(process.env.SMOKE_VERBOSE?.trim() ?? '');
/**
 * SMOKE_CHECK_TIMEOUT_S: a check still running after this fails instead of freezing the run.
 * Its work is not cancelled (a promise cannot be), only abandoned; anything it planted is in a
 * transaction that rolls back when the process exits.
 */
const timeoutMs = Number(process.env.SMOKE_CHECK_TIMEOUT_S ?? 300) * 1000;

export function group(name: string): void {
  currentGroup = name;
}

function wanted(groupName: string): boolean {
  const g = groupName.toLowerCase();
  return only.length === 0 || only.some((o) => g.includes(o));
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const MARK: Record<Status, string> = {
  pass: '\u001b[32m✓\u001b[0m',
  fail: '\u001b[31m✗\u001b[0m',
  skip: '\u001b[90m–\u001b[0m',
  info: '\u001b[36mi\u001b[0m',
};

/** Results are printed as they happen — a run that only reports at the end looks frozen for hours. */
function print(r: Result, ms?: number): void {
  if (r.group !== lastPrintedGroup) {
    process.stdout.write(`\n\u001b[1m${r.group}\u001b[0m\n`);
    lastPrintedGroup = r.group;
  }
  const time = ms === undefined ? '' : ` \u001b[90m(${seconds(ms)})\u001b[0m`;
  const detail = r.detail ? `  \u001b[90m${r.detail}\u001b[0m` : '';
  process.stdout.write(`  ${MARK[r.status]} ${r.name}${time}${detail}\n`);
}

function record(r: Result, ms?: number): void {
  results.push(r);
  print(r, ms);
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
  if (!wanted(currentGroup)) return;
  const groupName = currentGroup;
  if (verbose) {
    if (groupName !== lastPrintedGroup) {
      process.stdout.write(`\n\u001b[1m${groupName}\u001b[0m\n`);
      lastPrintedGroup = groupName;
    }
    process.stdout.write(`  \u001b[90m… ${name}\u001b[0m\n`);
  }
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${seconds(timeoutMs)} (SMOKE_CHECK_TIMEOUT_S)`)),
      timeoutMs,
    );
  });
  try {
    const detail = await Promise.race([Promise.resolve().then(fn), timeout]);
    const ms = performance.now() - started;
    record({ group: groupName, name, status: 'pass', ...(detail ? { detail } : {}) }, ms);
  } catch (err) {
    const ms = performance.now() - started;
    if (err instanceof Skip || (err as Error)?.name === 'Skip') {
      record({ group: groupName, name, status: 'skip', detail: (err as Error).message }, ms);
    } else {
      record(
        {
          group: groupName,
          name,
          status: 'fail',
          detail: err instanceof Error ? err.message : String(err),
        },
        ms,
      );
    }
  } finally {
    clearTimeout(timer);
    groupMs.set(groupName, (groupMs.get(groupName) ?? 0) + (performance.now() - started));
  }
}

/** A finding that is neither pass nor fail — a missing optional key, say. */
export function note(name: string, detail: string): void {
  if (!wanted(currentGroup)) return;
  record({ group: currentGroup, name, status: 'info', detail });
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Print the totals and return the process exit code. Each result was already
 * printed as it happened; this repeats only the failures, and where the time went.
 *
 * Only `fail` is fatal. A skip is usually a dev server that is not running, and
 * failing the whole run for that would train everyone to ignore the output.
 */
export function report(): number {
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  const failed = count('fail');

  process.stdout.write('\n\u001b[1mTime by group\u001b[0m\n');
  for (const [g, ms] of [...groupMs].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${seconds(ms).padStart(8)}  ${g}\n`);
  }

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
