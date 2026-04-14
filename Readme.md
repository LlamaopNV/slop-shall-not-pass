# slop-shall-not-pass

![You shall not pass](./docs/gandalf.gif)

A GitHub Actions quality gate that scores pull requests before they reach your reviewers. Blocks the obvious AI-generated filler so humans can focus on PRs that are actually worth reading.

## Why this exists

The curl project shut down its bug bounty because it was drowning in hallucinated AI vulnerability reports. Linux kernel maintainers went from 2 to 10 bug reports a week, most of them fabricated.
Every project with a public contribution model is dealing with the same problem PRs that look plausible at a glance and waste hours of review time once you dig in.

This repo is one attempt at a fix. It stands at the bridge and asks the hard questions before the reviewer has to.

## How it works

Two layers. The cheap one runs first and catches the obvious stuff. The expensive one handles the rest.

**Heuristics (0–40 points, free, runs in milliseconds)**

Deterministic checks on PR metadata. Title length and specificity, description word count, whether a bug fix includes reproduction steps, commit message quality, and pattern-matching against common templated boilerplate.

**Claude API scoring (0–60 points, roughly $0.01–0.03 per PR)**

The scorer sends the title, description, commit messages, and a small diff shape snippet to Claude deliberately not the full code and asks it to assess four things:

- Specificity: does the description explain what actually changed and why
- Coherence: do the title, commits, and description tell the same story
- Evidence: is there root-cause analysis or a repro
- Signal-to-noise: is this original writing or generic AI prose

Keeping the code diff out of the prompt keeps scoring cheap and catches most slop anyway, because low-effort PRs are almost always detectable from how they are described.

## Outcomes

| Score | What happens |
|-------|--------------|
| Below 40 | Commit status fails, `quality/blocked` label applied, merge is blocked until the description is improved |
| 40 to 70 | `quality/needs-review` label, human decides |
| Above 70 | `quality/cleared` label, PR joins the normal queue |

Every scored PR gets a comment with the breakdown and specific suggestions for what to fix.

## Setup

Copy `.github/workflows/pr-quality-gate.yml` and `.github/scripts/pr-scorer.js` into your repo.

Add your Anthropic API key under Settings → Secrets and variables → Actions as `ANTHROPIC_API_KEY`.

Under Settings → Branches, add `PR Quality Gate` to the required status checks on your main branch.

Open a test PR with a description like "fixes a bug" and watch it get turned away.

## Configuration

The thresholds live at the top of `pr-scorer.js`:

```js
const BLOCK_BELOW  = 40;
const REVIEW_BELOW = 70;
```

Start low. A block threshold of 30 will catch the worst offenders without frustrating people who just write terse commits. Raise it as you get a feel for what your repo's score distribution looks like.

## Feedback loop

Reviewers can apply two labels to correct the gate when it gets something wrong:

- `ai-slop` — gate missed it, this is low-quality
- `ai-assisted-valid` — gate was too harsh, this is actually fine

The workflow logs these. Pipe them wherever you like — a spreadsheet, a database, your analytics stack — and use the signal to tune thresholds based on real ground truth instead of guesses.

## What this does not do

It does not read your code. It scores the framing of a PR, not the correctness of what is inside it. A contributor can still ship well-described code with a subtle bug, and this will not catch that. It is not trying to.

It is not a silver bullet. Someone who puts effort into writing a good description of bad code will get through. The goal is to remove the obvious bottom tier of submissions so reviewers can spend their time on the cases where judgement actually matters.

It is not opinionated about AI-assisted contributions. A good PR written with Claude's help scores exactly as well as one written by hand. The gate rewards clarity and effort, not authorship.

## Cost

Around $0.01 to $0.03 per PR with Claude Sonnet. For most projects that is pennies per week. The heuristic layer runs first and catches a chunk of submissions before the API call happens at all.

## Roadmap

- Optional full-diff analysis mode for repos willing to pay more per scan
- Per-file scoring to catch trivial changes dressed up as major contributions
- Configurable scoring weights via a config file
- Webhook integration for shipping reviewer labels to external analytics
- Self-hosted scoring option for projects that cannot send PR content to a third-party API

## Contributing

PRs welcome. They will be scored by the gate they are contributing to, which is either unfair or fitting depending on how you look at it.

If you open a PR, describe what changed and why. If it is a bug fix, include how to reproduce the bug. Write commit messages someone could actually read.

## Acknowledgments

Inspired by the curl project and Linux kernel maintainers' public writing about the AI slop problem, and by the broader conversation around AI-driven vulnerability research in *The AI Vulnerability Storm: Building a Mythos-ready Security Program* from the CSA CISO Community, SANS, and OWASP GenAI Security Project.

## License

MIT. See [LICENSE](LICENSE).
