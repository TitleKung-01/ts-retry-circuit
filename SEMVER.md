# Semantic Versioning Policy

This package follows [SemVer 2.0.0](https://semver.org/).

## What counts as a breaking change (MAJOR)

- Removing or renaming a public export
- Changing default behavior in a way that alters production outcomes for existing configs
- Narrowing TypeScript types of public APIs
- Raising the minimum supported Node.js major version

## What counts as a feature (MINOR)

- Additive config options with safe defaults
- New optional exports / subpath entries
- New events, metrics fields, or helpers that do not change existing defaults

## What counts as a fix (PATCH)

- Bug fixes that restore documented behavior
- Documentation, CI, and tooling-only changes
- Performance improvements that preserve behavior

## Deprecation

Deprecated APIs are marked in JSDoc and listed in `CHANGELOG.md` for at least one MINOR release before removal in a MAJOR.
