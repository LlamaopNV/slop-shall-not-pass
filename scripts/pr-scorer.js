
 /*
 * Scores a PR for quality using a two-layer approach:
 *   1. Cheap heuristics on PR metadata
 *   2. Claude API for semantic assessment of title + description + commits
 *
 * Outputs a score (0-100), a label decision, and posts a comment to the PR.
 * Intentionally avoids full code analysis to keep costs low.
 *
 * Required env vars:
 *   GITHUB_TOKEN, ANTHROPIC_API_KEY, PR_NUMBER, REPO_OWNER, REPO_NAME, HEAD_SHA
 */

const { Octokit } = require('@octokit/rest');
const { execSync } = require('child_process');
const fs = require('fs');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const OWNER = process.env.REPO_OWNER;
const REPO  = process.env.REPO_NAME;
const PR    = parseInt(process.env.PR_NUMBER, 10);

const BLOCK_BELOW  = 40;
const REVIEW_BELOW = 70;

const LABELS = {
  blocked:     'quality/blocked',
  needsReview: 'quality/needs-review',
  cleared:     'quality/cleared',
};

// ─── Heuristics ─────────────────────────────────────────────────────────────

/**
 * Run fast, free checks on PR metadata.
 * Returns { score: 0–40, notes: string[] }
 */
function runHeuristics(pr, commits) {
  const notes = [];
  let score = 0;

  const body  = (pr.body  || '').trim();
  const title = (pr.title || '').trim();

  // 1. Title quality (0-8)
  if (title.length < 10) {
    notes.push('Title is very short — describe what the change does.');
  } else if (/^(fix|update|change|wip|test|misc|stuff|pr)\s*$/i.test(title)) {
    notes.push('Title is a generic placeholder word.');
  } else if (title.length > 20) {
    score += 8;
  } else {
    score += 4;
    notes.push('Title could be more descriptive.');
  }

  // 2. Description length (0-8)
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  if (wordCount < 10) {
    notes.push('Description is too short. Explain what changed and why.');
  } else if (wordCount < 30) {
    score += 3;
    notes.push('Description is brief. More context helps reviewers.');
  } else if (wordCount < 80) {
    score += 6;
  } else {
    score += 8;
  }

  // 3. Reproduction steps (0-8) — relevant for bug fixes
  const isBugFix = /\b(fix|bug|issue|error|crash|regression|broken)\b/i.test(title + body);
  if (isBugFix) {
    const hasRepro = /\b(steps? to reproduce|repro|how to reproduce|to reproduce|reproduction)\b/i.test(body);
    if (!hasRepro) {
      notes.push('Bug fix detected but no reproduction steps found.');
    } else {
      score += 8;
    }
  } else {
    score += 6; // non-bug PRs don't need repro steps
  }

  // 4. Commit message quality (0-8)
  const commitMessages = commits.map(c => c.commit.message.split('\n')[0]);
  const genericCommits = commitMessages.filter(m =>
    /^(fix|update|change|wip|test|misc|stuff|commit|pr|changes?|edits?)\s*\.?$/i.test(m.trim())
  );
  if (genericCommits.length === commitMessages.length) {
    notes.push('All commit messages are generic. Use imperative descriptions.');
  } else if (genericCommits.length > 0) {
    score += 4;
    notes.push(`${genericCommits.length} generic commit message(s): ${genericCommits.slice(0, 2).join(', ')}`);
  } else {
    score += 8;
  }

  // 5. Template / boilerplate signals (0-8)
  const sloppyPatterns = [
    /this (pr|commit|change) (fix(es)?|update?s?|add?s?) .{0,20}$/i,
    /i (used|tried|asked) (claude|chatgpt|gpt|ai|llm)/i,
    /as per (the )?(requirements?|spec|ticket)/i,
    /\[insert .+?\]/i,
    /lorem ipsum/i,
  ];
  const sloppyHits = sloppyPatterns.filter(p => p.test(body));
  if (sloppyHits.length > 0) {
    notes.push(`Description contains suspicious boilerplate patterns (${sloppyHits.length} match${sloppyHits.length > 1 ? 'es' : ''}).`);
  } else {
    score += 8;
  }

  return { score, notes };
}

// ─── LLM Scoring ────────────────────────────────────────────────────────────

/**
 * Ask Claude to score the PR metadata semantically.
 * We deliberately do NOT send full code diffs — just metadata + first 500 chars of diff.
 * Returns { score: 0–60, reasoning: string, flags: string[], breakdown: {} }
 */
async function scoreWithClaude(pr, commits, diffSnippet) {
  const commitSummary = commits
    .slice(0, 10)
    .map(c => `- ${c.commit.message.split('\n')[0]}`)
    .join('\n');

  const prompt = `You are a code review quality assessor. A contributor has submitted a pull request. Your job is to determine whether this is a thoughtful, substantive contribution or low-quality AI-generated filler ("AI slop").

PULL REQUEST METADATA:
Title: ${pr.title}

Description:
${(pr.body || '(empty)').slice(0, 1500)}

Commit messages (up to 10):
${commitSummary}

Diff shape (first 500 chars, not full code):
${diffSnippet}

Score this PR on these four dimensions (0-15 each, total 0-60):

1. SPECIFICITY: Does the description explain exactly what changed and why? Vague or template-like descriptions score low.
2. COHERENCE: Do the title, description, and commit messages tell a consistent story? Mismatch between stated purpose and actual diff is a red flag.
3. EVIDENCE: Does the contributor show they understand the problem? Bug fixes should include repro steps or root-cause analysis.
4. SIGNAL-TO-NOISE: Is the text genuinely informative, or padded with generic AI prose? Watch for: hallucinated CVE numbers, claiming to "fix a critical security vulnerability" with no specifics, listing every feature of a library, flowery language with no substance.

Respond ONLY with valid JSON in this exact shape — no preamble, no markdown fences:
{
  "specificity": <0-15>,
  "coherence": <0-15>,
  "evidence": <0-15>,
  "signal_to_noise": <0-15>,
  "total": <0-60>,
  "flags": ["brief flag if something notable", ...],
  "reasoning": "2-3 sentence summary of your assessment"
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '{}';

  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return {
      score:     Math.min(60, Math.max(0, parsed.total || 0)),
      reasoning: parsed.reasoning || '',
      flags:     parsed.flags || [],
      breakdown: {
        specificity:     parsed.specificity,
        coherence:       parsed.coherence,
        evidence:        parsed.evidence,
        signal_to_noise: parsed.signal_to_noise,
      },
    };
  } catch {
    return { score: 30, reasoning: 'Could not parse scoring response.', flags: [], breakdown: {} };
  }
}

// ─── GitHub helpers ──────────────────────────────────────────────────────────

function getDiffSnippet() {
  try {
    const stat = execSync(`git diff --stat HEAD~1 HEAD 2>/dev/null | head -20`, { encoding: 'utf8' });
    return stat.slice(0, 500);
  } catch {
    return '(diff unavailable)';
  }
}

async function ensureLabelsExist() {
  const labelDefs = [
    { name: LABELS.blocked,     color: 'b60205', description: 'PR blocked by quality gate' },
    { name: LABELS.needsReview, color: 'e4e669', description: 'PR needs manual quality review' },
    { name: LABELS.cleared,     color: '0e8a16', description: 'PR cleared quality gate' },
  ];

  for (const label of labelDefs) {
    try {
      await octokit.rest.issues.createLabel({ owner: OWNER, repo: REPO, ...label });
    } catch (e) {
      if (e.status !== 422) console.warn(`Label warning: ${e.message}`);
    }
  }
}

async function setLabel(prNumber, labelName) {
  for (const l of Object.values(LABELS)) {
    try {
      await octokit.rest.issues.removeLabel({
        owner: OWNER, repo: REPO, issue_number: prNumber, name: l,
      });
    } catch { /* label wasn't on PR, ignore */ }
  }
  await octokit.rest.issues.addLabels({
    owner: OWNER, repo: REPO, issue_number: prNumber, labels: [labelName],
  });
}

async function postOrUpdateComment(prNumber, body) {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner: OWNER, repo: REPO, issue_number: prNumber,
  });

  const existing = comments.find(c =>
    c.user?.login === 'github-actions[bot]' &&
    c.body?.includes('<!-- pr-quality-gate -->')
  );

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: OWNER, repo: REPO, comment_id: existing.id, body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner: OWNER, repo: REPO, issue_number: prNumber, body,
    });
  }
}

// ─── Comment builder ─────────────────────────────────────────────────────────

function buildComment({ totalScore, heuristics, llm }) {
  const scoreBar = (s, max) => {
    if (typeof s !== 'number') return `?/${max}`;
    const filled = Math.round((s / max) * 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${s}/${max}`;
  };

  let statusLine, outcomeText;
  if (totalScore < BLOCK_BELOW) {
    statusLine = `## PR blocked — quality score: ${totalScore}/100`;
    outcomeText = `This PR did not meet the minimum quality threshold (${BLOCK_BELOW}). Address the issues below and update the PR description.`;
  } else if (totalScore < REVIEW_BELOW) {
    statusLine = `## Needs review — quality score: ${totalScore}/100`;
    outcomeText = `This PR scored in the manual-review zone (${BLOCK_BELOW}–${REVIEW_BELOW}). A reviewer will decide whether it progresses.`;
  } else {
    statusLine = `## Cleared — quality score: ${totalScore}/100`;
    outcomeText = `This PR passed the quality gate and is queued for review.`;
  }

  const heuristicIssues = heuristics.notes.length
    ? heuristics.notes.map(n => `- ${n}`).join('\n')
    : '- No heuristic issues found.';

  const llmFlags = llm.flags.length
    ? llm.flags.map(f => `- ${f}`).join('\n')
    : '- No additional flags.';

  const b = llm.breakdown;

  return `<!-- pr-quality-gate -->
${statusLine}

${outcomeText}

---

### Heuristic checks \`${heuristics.score}/40\`

${heuristicIssues}

---

### Semantic assessment \`${llm.score}/60\`

| Dimension | Score |
|-----------|-------|
| Specificity | ${scoreBar(b.specificity, 15)} |
| Coherence | ${scoreBar(b.coherence, 15)} |
| Evidence | ${scoreBar(b.evidence, 15)} |
| Signal-to-noise | ${scoreBar(b.signal_to_noise, 15)} |

**Reasoning:** ${llm.reasoning}

${llmFlags}

---

<details>
<summary>How to improve your score</summary>

- Specificity: explain exactly what changed and why. Avoid vague statements like "fixed a bug" — name the bug.
- Evidence: for bug fixes, include steps to reproduce. For features, link to the relevant issue or spec.
- Coherence: title, description, and commit messages should all tell the same story.
- Signal-to-noise: write in your own words. Generic AI-generated prose scores poorly.

Reviewers can apply \`ai-slop\` or \`ai-assisted-valid\` labels to give feedback that improves this gate over time.
</details>

_Scored by [slop-shall-not-pass](https://github.com/${OWNER}/${REPO})_`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Scoring PR #${PR} in ${OWNER}/${REPO}...`);

  const [{ data: pr }, { data: commits }] = await Promise.all([
    octokit.rest.pulls.get({ owner: OWNER, repo: REPO, pull_number: PR }),
    octokit.rest.pulls.listCommits({ owner: OWNER, repo: REPO, pull_number: PR, per_page: 20 }),
  ]);

  const diffSnippet = getDiffSnippet();

  const heuristics = runHeuristics(pr, commits);
  const llm        = await scoreWithClaude(pr, commits, diffSnippet);

  const totalScore = heuristics.score + llm.score;
  console.log(`Heuristics: ${heuristics.score}/40 | LLM: ${llm.score}/60 | Total: ${totalScore}/100`);

  await ensureLabelsExist();
  if (totalScore < BLOCK_BELOW) {
    await setLabel(PR, LABELS.blocked);
  } else if (totalScore < REVIEW_BELOW) {
    await setLabel(PR, LABELS.needsReview);
  } else {
    await setLabel(PR, LABELS.cleared);
  }

  const comment = buildComment({ totalScore, heuristics, llm });
  await postOrUpdateComment(PR, comment);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `score=${totalScore}\nsummary=${llm.reasoning.replace(/\n/g, ' ')}\n`
    );
  }

  console.log('Done.');
  process.exit(totalScore < BLOCK_BELOW ? 1 : 0);
}

main().catch(err => {
  console.error('Scorer failed:', err);
  process.exit(1);
});
