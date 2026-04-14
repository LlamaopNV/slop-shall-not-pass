# Contributing

Thanks for considering a contribution. This project exists to filter low-effort and AI-generated pull requests, so the bar for contributions here is accordingly higher than for most repos. Your PR will be scored by the gate it is contributing to.

## Before you open a PR

Make sure your submission would pass its own gate:

- **Title** describes what actually changed. Not "fix", not "update", not "wip".
- **Description** explains what the change does and why it is needed. If it fixes a bug, include steps to reproduce. If it adds a feature, link to the issue or discussion that motivated it.
- **Commit messages** are imperative and specific. `git rebase -i` is your friend if you need to clean up.
- **Scope** is narrow. One logical change per PR. If you find yourself describing the PR with the word "and", consider splitting it.

## Development setup

```bash
git clone https://github.com/LlamaopNV/slop-shall-not-pass.git
cd slop-shall-not-pass
npm install
```

To run the scorer against a local fixture without needing a real PR:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm test
```

See `test/fixtures/` for example PRs covering the full score range. Add a new fixture when you add a new heuristic or want to demonstrate a case the gate currently misses.

## What kinds of changes are welcome

- New heuristics for patterns the current gate misses
- Improvements to the Claude scoring prompt based on observed failure modes
- Additional test fixtures, especially edge cases and borderline PRs
- Documentation clarifications
- Cost optimizations
- Bug fixes

## What to discuss first

- Changes to the scoring thresholds or their semantics
- Swapping the model provider or adding a second one
- Anything that changes the shape of the PR comment output

Open an issue before starting work on those so we can align on direction.

## Reporting issues

If the gate is catching good PRs or missing obvious slop, open an issue with the PR number and a short explanation of why the score was wrong. Those reports are the most useful signal for tuning the gate.
