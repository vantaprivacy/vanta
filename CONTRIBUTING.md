# Contributing to VANTA

Thank you for considering contributing to VANTA Protocol.

## Development Setup

```bash
# Clone
git clone https://github.com/vantaprivacy/vanta.git
cd vanta

# Install dependencies
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

## Branch Naming

- `feat/description` — new features
- `fix/description` — bug fixes
- `refactor/description` — code improvements
- `docs/description` — documentation
- `test/description` — test additions

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add intent batching support
fix(mev): handle edge case in sandwich detection
docs(readme): update installation instructions
test(slashing): add tombstone edge case coverage
refactor(privacy): extract key rotation into separate module
```

Scope should be one of: `core`, `mev`, `zk`, `consensus`, `sdk`, `cli`, `docs`, `ci`.

## Pull Request Process

1. Fork the repo and create your branch from `main`
2. Add tests for any new functionality
3. Ensure `npm test` and `npm run typecheck` pass
4. Update documentation if you changed public APIs
5. Reference any related issues in the PR description

## Code Review

All PRs require at least one review from a maintainer. Security-sensitive changes (crypto, slashing, MEV) require two reviews.

## Feature Flags

New experimental features must be gated behind a feature flag in `src/config/features.ts`. See RFC-0001 for the feature flag policy.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
