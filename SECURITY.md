# Security Policy

## Supported versions

| Version | Supported |
| :--- | :--- |
| 2.1.x | Yes |
| 2.0.x | Yes (upgrade recommended) |
| 1.x | No (upgrade to 2.x) |
| < 1.0 | No |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately via one of:

1. GitHub Security Advisories: [Report a vulnerability](https://github.com/TitleKung-01/ts-retry-circuit/security/advisories/new)
2. Email the maintainer through the contact listed on the [GitHub profile](https://github.com/TitleKung-01) if advisories are unavailable

Include:

- Affected package version(s)
- Reproduction steps or proof of concept
- Impact assessment (confidentiality / integrity / availability)
- Any suggested fix, if you have one

You should receive an acknowledgement within **7 days**. We aim to publish a fix or mitigation guidance within **30 days** for confirmed issues, depending on severity and complexity.

## Scope

In scope:

- Vulnerabilities in published `ts-retry-circuit` runtime code
- Supply-chain issues in the npm publish artifacts for this package
- Prototype pollution or unsafe handling introduced by this library’s public APIs

Out of scope:

- Vulnerabilities in consumer application code that merely *uses* the library
- Issues that require unrealistic privileges on the host already compromised
- Denial of service from values already rejected by config bounds (callers must catch constructor errors)

## Hardening in 2.1

| Risk | Mitigation |
| :--- | :--- |
| Unbounded retries / delays | Constructor enforces hard config bounds |
| Timeout leaving work running | Each attempt gets an `AbortSignal`; timeout aborts it |
| React registry growth | `instanceKey` ref-counted; removed when last subscriber unmounts |
| Unsafe `instanceKey` shapes | Keys must match `^[a-zA-Z0-9:_./-]+$` (max 128) |
| Accidental HALF-OPEN stampede | Synchronous `halfOpenProbeActive` guard |
| Accidental public reset | `reset()` remains available but documented as ops/admin/tests only |

Publish surface remains `files: ["dist"]` with zero runtime dependencies. Prefer lockfiles and `npm audit` in consuming apps.

## Supply Chain Security

`ts-retry-circuit` implements strict supply chain controls:

1. **Zero Runtime Dependencies**: Package has `"dependencies": {}` preventing transitive dependency injection attacks.
2. **SLSA Build Provenance**: NPM releases are built and signed using cryptographic build attestations (`npm publish --provenance`) on GitHub Actions via OIDC.
3. **Least-Privilege CI Tokens**: GitHub Workflows enforce scoped permissions (`contents: read`, `security-events: write`).
4. **Automated Security Auditing**: Repository is analyzed by CodeQL SAST, OpenSSF Scorecard, and Dependabot.

## Safe usage notes

- Pass the attempt signal into I/O: `execute(({ signal }) => fetch(url, { signal }))`
- Prefer typed errors (`instanceof` / `.code`) over parsing `error.message`
- Do not put secrets into fallback return values that may be logged
- Use stable dependency `instanceKey` values (e.g. `"payments"`). Do **not** use end-user ids
- Do not bind `reset()` to a public end-user control; wrap auth at the application layer if needed
- Fallback return values must match the expected success shape; otherwise rethrow

## Residual risks (accepted)

- If the consumer ignores `signal`, underlying I/O may continue after timeout
- Anyone holding a breaker reference can call `reset()`; enforce authorization in the app
- Intentionally shared `instanceKey` values share circuit state by design

## Disclosure

We ask reporters to allow time for a fix before public disclosure. Credit will be given in release notes when requested and appropriate.
# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 2.x     | Yes       |
| 1.x     | No        |

## Reporting a Vulnerability

Please report security issues privately via GitHub Security Advisories for this repository:

https://github.com/TitleKung-01/ts-retry-circuit/security/advisories/new

Include steps to reproduce, impact, and any suggested fix. Do not open a public issue for undisclosed vulnerabilities.

We aim to acknowledge reports within 7 days and ship a fix or mitigation for confirmed issues as soon as practical.
