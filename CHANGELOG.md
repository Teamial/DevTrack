# Change Log

All notable changes to the "devtrack" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- (none)

## [8.0.0]

### Added
- Default **private** tracking repo creation with `devtrack.repoVisibility`
- Privacy controls via `devtrack.privacyLevel` (defaults to extension-level aggregates)
- `devtrack.autoStart` to start tracking automatically on startup

### Changed
- Tracking data is now **metadata-only JSON logs** (no code snippets or file contents are pushed)
- Improved git sync reliability: safer fetch/rebase retry on non-fast-forward pushes (no force push)
- Status bar countdown is single-source and only runs when tracking is active

### Fixed
- Adaptive scheduling toggle now respects `devtrack.enableAdaptiveScheduling=false`
- Pause/resume properly stops/starts the scheduler loop