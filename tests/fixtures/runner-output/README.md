# Runner output fixtures

These captures come from tiny source projects run in a private temporary directory.
The capture worker removed the temporary projects and runner installations after capture.
`<TMP>` marks a normalized private temporary root.
The fixtures omit trailing spaces and blank lines at the end.
All other output remains intact.
Turbo retains the captured host npm path.

## Runner versions

- pytest 9.2.0, Python 3.11.14
- Vitest 5.1.0, Node.js 24.4.1
- Jest 30.5.2, Node.js 24.4.1
- Go test, Go 1.27.1
- Turbo 2.11.10, Node.js 24.4.1, npm 11.4.2

JavaScript runners were installed into a private npm project with `npm install vitest@latest jest@latest turbo@latest`. pytest was installed into a private virtual environment with `pip install pytest`. The captured resolved versions are listed above.

## Captures

| Files | Source fixture | Exact runner command | Exit codes: pass and fail |
| --- | --- | --- | --- |
| `pytest-pass.txt`, `pytest-fail.txt` | `test_sample.py` asserts `2 + 2 == 4`; `test_failure.py` asserts `2 + 2 == 5` with test name `test_named_failure` | `python -m pytest -q test_sample.py`; `python -m pytest -q test_failure.py` | 0 / 1 |
| `vitest-pass.txt`, `vitest-fail.txt` | `sample.test.js` expects 4; `failure.test.js` expects 5 with test name `named failure` | `vitest run --reporter=default sample.test.js`; `vitest run --reporter=default failure.test.js` | 0 / 1 |
| `jest-pass.txt`, `jest-fail.txt` | `sample.test.js` expects 4; `failure.test.js` expects 5 with test name `named failure` | `jest --runInBand --noStackTrace sample.test.js`; `jest --runInBand --noStackTrace failure.test.js` | 0 / 1 |
| `go-test-pass.txt`, `go-test-fail.txt` | `sample_test.go` checks 4; `failure_test.go` has `TestNamedFailure` and reports `named assertion: expected 5` | `go test -v -count=1 -run '^TestSample$' ./`; `go test -v -count=1 -run TestNamedFailure ./` | 0 / 1 |
| `turbo-pass.txt`, `turbo-fail.txt` | Actual Turbo `check` task runs `node check.js`; `FIXTURE_FAIL=1` makes it print `named task failure` and exit 1. `FIXTURE_FAIL` is declared in `globalPassThroughEnv`. | `turbo run check --output-logs=full`; `FIXTURE_FAIL=1 turbo run check --output-logs=full` | 0 / 1 |

The pytest, Vitest, and Jest projects include one named assertion in each invocation. Go's pass command selects only `TestSample`; its fail command selects only `TestNamedFailure`. Turbo runs its task orchestration for both outcomes. No test output was handcrafted. Timing, temporary paths, Turbo task hashes, and cache-miss identifiers vary between runs. The fixtures normalize private temporary roots, trailing spaces, and blank lines at the end. Each output file is under 1 KB.
