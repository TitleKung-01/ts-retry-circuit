# Security Policy

## Supported versions

| Version | Supported |
| :--- | :--- |
| 2.x | Yes |
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
- Denial of service caused solely by intentional misconfiguration (e.g. unbounded retries with zero delay)

## Safe usage notes

- Prefer typed errors (`instanceof` / `.code`) over parsing `error.message`
- Do not put secrets into fallback return values that may be logged
- Bound `maxRetries`, `timeout`, and `cooldownPeriod` appropriately for your dependency
- Treat `releaseInstance` / shared `instanceKey` carefully in multi-tenant frontends so tenants do not share circuit state unintentionally

## Disclosure

We ask reporters to allow time for a fix before public disclosure. Credit will be given in release notes when requested and appropriate.
