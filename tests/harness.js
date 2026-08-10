/**
 * harness.js — a dependency-free test runner.
 *
 * No jest/vitest: this app ships to a box whose default Node is 16 and whose
 * npm install should stay as small as possible. `node tests/run.js` is enough.
 */

const suites = [];
let current = null;

function describe(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

function it(name, fn) {
  if (!current) throw new Error('it() outside describe()');
  current.tests.push({ name, fn });
}

function fail(message) {
  throw new Error(message);
}

const expect = (actual) => ({
  toBe(expected) {
    if (actual !== expected) {
      fail(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  toEqual(expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) fail(`expected ${b}, got ${a}`);
  },
  toBeTruthy() {
    if (!actual) fail(`expected truthy, got ${JSON.stringify(actual)}`);
  },
  toBeFalsy() {
    if (actual) fail(`expected falsy, got ${JSON.stringify(actual)}`);
  },
  toBeNull() {
    if (actual !== null) fail(`expected null, got ${JSON.stringify(actual)}`);
  },
  toContain(needle) {
    if (typeof actual === 'string') {
      if (!actual.includes(needle)) fail(`expected "${actual}" to contain "${needle}"`);
      return;
    }
    if (Array.isArray(actual)) {
      if (!actual.includes(needle)) {
        fail(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(needle)}`);
      }
      return;
    }
    fail(`toContain: unsupported subject ${typeof actual}`);
  },
  toHaveLength(n) {
    if (!actual || actual.length !== n) {
      fail(`expected length ${n}, got ${actual ? actual.length : 'n/a'}`);
    }
  },
});

/** Assert an async fn rejects, and return the error for further assertions. */
async function expectRejection(fn, { code, messageContains } = {}) {
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  if (!error) fail('expected the call to be rejected, but it resolved');
  if (code && error.code !== code) {
    fail(`expected rejection code "${code}", got "${error.code}" (${error.message})`);
  }
  if (messageContains && !error.message.includes(messageContains)) {
    fail(`expected message to contain "${messageContains}", got "${error.message}"`);
  }
  return error;
}

async function run() {
  let passed = 0;
  const failures = [];

  for (const suite of suites) {
    console.log(`\n  ${suite.name}`);
    for (const test of suite.tests) {
      try {
        await test.fn();
        passed += 1;
        console.log(`    [32m✓[0m ${test.name}`);
      } catch (err) {
        failures.push({ suite: suite.name, test: test.name, err });
        console.log(`    [31m✗[0m ${test.name}`);
        console.log(`      [31m${err.message}[0m`);
      }
    }
  }

  console.log(
    `\n  ${passed} passed, ${failures.length} failed, ${passed + failures.length} total\n`
  );

  if (failures.length) process.exitCode = 1;
  return failures.length === 0;
}

export { describe, it, expect, expectRejection, run };
