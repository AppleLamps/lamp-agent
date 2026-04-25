// Intentionally wrong: returns the sum minus one so the spec's expected
// result diverges from the actual result. The lamp-agent E2E suite uses
// this to exercise the verify-and-repair loop's failure path.
export function brokenAdd(a, b) {
  return a + b - 1;
}
