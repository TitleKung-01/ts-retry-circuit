# Versioning (SemVer)

`ts-retry-circuit` follows [Semantic Versioning 2.0.0](https://semver.org/).

Given a version `MAJOR.MINOR.PATCH`:

| Change | Bump | Examples |
| :--- | :--- | :--- |
| Bug fix, docs, tests, internal refactors with no public API change | **PATCH** | Fix timeout cleanup; clarify README |
| Backward-compatible API or behavior additions | **MINOR** | New optional config field; new exported helper |
| Breaking public API or intentional behavior change | **MAJOR** | Rename/remove exports; change default semantics |

## Public API surface

Breaking-change review applies to:

- Package entry points: `ts-retry-circuit`, `ts-retry-circuit/react`
- Exported classes, functions, types, and error `code` string literals
- Documented defaults for `CircuitConfig` / hook options
- Documented state machine behavior (`CLOSED` → `OPEN` → `HALF-OPEN`)

Not part of the SemVer contract:

- Private/`_`-prefixed members
- Exact error `message` text (use `instanceof` or `.code`)
- Undocumented internal counters or timing jitter randomness
- Dev-only tooling (ESLint, Vitest, tsup config)

## Compatibility promises

- **TypeScript**: Public types are part of the contract for the supported TS versions listed in CI / peer ranges.
- **React**: Optional peer; major React peer range expansions are usually **MINOR** unless the hook API breaks.
- **Node / bundlers**: Dual ESM + CJS builds are maintained; dropping a format or Node engine floor is **MAJOR**.

## Pre-releases

Optional tags such as `2.1.0-beta.1` may be published for early feedback. Pre-releases are not guaranteed stable and may break without a major bump.

## Release checklist

1. Update `package.json` `version`
2. Update `README.md` migration notes when releasing a **MAJOR**
3. Run `npm run validate` and `npm run build`
4. Commit, tag `vX.Y.Z`, push
5. `npm publish --access public`

## Historical note

- **v1 → v2**: Typed circuit errors replaced emoji plain `Error` rejects; callers matching `error.message` must migrate to `instanceof` / `.code`. See README “Migrating from v1 to v2”.
- **v2.1.0**: Security hardening MINOR — config bounds, attempt `AbortSignal`, HALF-OPEN probe flag, React registry ref-counting + `instanceKey` validation. Existing `execute(async () => …)` call sites remain valid; prefer `execute(({ signal }) => …)`.
