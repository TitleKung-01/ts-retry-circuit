# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See also [SEMVER.md](./SEMVER.md).

## [2.1.0] - 2026-08-02

### Added

- GitHub Actions CI (Node 20/22, Ubuntu/Windows), coverage gate, Dependabot
- `SECURITY.md`, `SEMVER.md`, `engines.node` (use `npm publish --provenance` from GitHub Actions when desired)
- Typed event bus (`on` / `off` / `once`): `open`, `close`, `halfOpen`, `success`, `failure`, `reject`, `timeout`, `fallback`, `retry`
- Named process registry: `CircuitRegistry` / `CircuitBreaker.get` / `register` / `release`
- Bulkhead `capacity` with `CircuitCapacityRejectedError`
- Rolling failure strategy (`strategy: "rolling"`) with volume / error % thresholds
- Richer metrics: `attemptCount`, `totalDurationMs`, `fallbackCount`, `timeoutCount`, `retryCount`
- Timeout cancels work via merged `AbortSignal` passed into `execute(fn)`
- `withCircuit` / `createCircuitFetch` / `circuitFetchFromConfig`
- React `CircuitProvider`, richer hook metrics (`metrics`, `nextAttemptTime`, `breaker`)
- Optional OpenTelemetry entry: `ts-retry-circuit/otel`
- Cookbook, examples, benchmarks, expanded tests

### Changed

- `execute` invokes work as `(signal: AbortSignal) => Promise<T>` (zero-arg async callbacks remain compatible)

## [2.0.0] - 2026-08-01

### Added

- Typed circuit errors (`CircuitOpenError`, `CircuitHalfOpenThrottledError`, `CircuitTimeoutError`, `CircuitAbortedError`)
- Per-attempt `timeout`, `fallback`, `halfOpenSuccessThreshold`
- `execute(fn, { signal })`, `reset()`, `getMetrics()`, `subscribe()`
- Expanded Vitest coverage for core and React hook

### Changed

- Rejects when open/throttled are typed errors instead of plain `Error` message strings

## [1.0.3] - 2026-07-19

### Fixed

- Package metadata and publish hygiene

## [1.0.0] - 2026-07-19

### Added

- Initial circuit breaker with retry + React `useCircuitBreaker`
