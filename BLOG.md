# Building Niteni: An AI Code Review Bot for GitLab with Zero Dependencies

> *Niteni* — Javanese for "to observe carefully." That's what this tool does: it watches your merge requests and tells you what you missed.

I built Niteni to solve a simple problem: I wanted automated, inline code review comments on GitLab merge requests, powered by Google's Gemini, without pulling in half of npm. Here's how it went — and the surprising number of things that bit me along the way.

## The Idea

GitLab's CI/CD pipelines are powerful, but there's no built-in "AI review" step. GitHub has Copilot reviews. GitLab has... nothing out of the box. I wanted something that would:

1. Run inside a standard GitLab CI job
2. Post findings as **inline diff comments** (not a wall-of-text MR note)
3. Provide one-click "Apply suggestion" buttons
4. Work without any runtime dependencies beyond Node.js itself

That last point was a deliberate constraint. CI environments are ephemeral. Every `npm install` in a pipeline is wasted time and a potential point of failure. So Niteni uses only Node.js built-ins: `https`, `child_process`, `fs`, `path`, `os`, and `url`.

## Architecture: The Cascading Fallback Strategy

The most interesting design decision was the three-tier review strategy. Gemini can be accessed in multiple ways, and each has trade-offs:

1. **Gemini REST API** — Direct HTTP call. Most reliable, gives us full control over the prompt and response format.
2. **Gemini CLI `/code-review` extension** — A community extension that runs `git diff` internally. Convenient, but output format isn't guaranteed.
3. **Gemini CLI with direct prompt** — Last resort. Pass the diff as a prompt to `gemini -p`.

The cascade means Niteni degrades gracefully. If the API key works but the CLI isn't installed, it still works. If the REST API is down, it falls back. If nothing works, it throws a clear error.

```typescript
async review(diffContent: string): Promise<string> {
  // Strategy 1: REST API (most reliable)
  try {
    const apiResult = await this.reviewWithAPI(diffContent);
    if (apiResult && this.isStructuredReview(apiResult)) return apiResult;
  } catch (err) { /* fall through */ }

  // Strategy 2: CLI extension
  const extensionResult = await this.reviewWithCodeReviewExtension();
  if (extensionResult) return extensionResult;

  // Strategy 3: CLI direct prompt
  const cliResult = await this.reviewWithGeminiCLI(diffContent);
  if (cliResult) return cliResult;

  throw new Error('All review strategies failed.');
}
```

Each strategy validates the output with `isStructuredReview()` — a regex check for `### Summary`, `### Findings`, or severity markers. This prevents garbage output from being posted as a review comment.

## Gotcha #1: GitLab CI Variable Circular References

This one cost me hours of debugging. In `.gitlab-ci.yml`, if you do this:

```yaml
niteni-code-review:
  variables:
    GEMINI_API_KEY: $GEMINI_API_KEY
    GITLAB_TOKEN: $GITLAB_TOKEN
  script:
    - niteni --mode mr
```

It looks reasonable — you're just "passing through" the project-level CI/CD variables. But GitLab interprets this as a **circular reference**. The variable `GEMINI_API_KEY` expands to the literal string `$GEMINI_API_KEY` instead of the actual secret value.

**The fix:** Don't re-declare project-level CI/CD variables in the `variables:` section. They're already available in every job automatically. Only declare variables in the job if they're new values (like `GEMINI_MODEL: gemini-2.5-flash`).

## Gotcha #2: Token Authentication is a Maze

GitLab supports three authentication methods, and picking the wrong header silently fails:

| Token type | Header |
|-----------|--------|
| Personal/Project access token | `PRIVATE-TOKEN: glpat-xxx` |
| CI job token | `JOB-TOKEN: $CI_JOB_TOKEN` |
| OAuth token | `Authorization: Bearer xxx` |

My first implementation always used `PRIVATE-TOKEN`. It worked locally but failed in CI because `$CI_JOB_TOKEN` requires the `JOB-TOKEN` header. The config module now auto-detects the token type:

```typescript
function resolveToken() {
  const gitlabToken = env.GITLAB_TOKEN && !env.GITLAB_TOKEN.startsWith('$')
    ? env.GITLAB_TOKEN : null;
  if (gitlabToken) return { token: gitlabToken, tokenType: 'private' };
  if (env.CI_JOB_TOKEN) return { token: env.CI_JOB_TOKEN, tokenType: 'job' };
  return { token: '', tokenType: 'private' };
}
```

Notice the `!env.GITLAB_TOKEN.startsWith('$')` guard — that catches the circular reference gotcha from above. If the variable expanded to a literal `$GITLAB_TOKEN` string, we fall through to `CI_JOB_TOKEN`.

## Gotcha #3: Inline Diff Comments Need `diff_refs`

GitLab's MR discussion API accepts a `position` parameter for inline comments. But the position requires three SHA values: `base_sha`, `start_sha`, and `head_sha`. These come from the MR's `diff_refs` field.

If `diff_refs` is null (which happens with certain merge strategies or force-pushes), the inline comment fails with a 400 error. The fallback? Post as a general discussion comment instead.

```typescript
if (diffRefs) {
  try {
    await gitlab.postMergeRequestDiscussion(mrIid, body, position);
  } catch {
    // Fallback: post as general discussion without position
    await gitlab.postMergeRequestDiscussion(mrIid, body);
  }
}
```

This two-tier posting strategy means the review always gets posted, even if it can't be pinned to the exact line.

## Gotcha #4: Parsing LLM Output is Fragile

Gemini's output is structured markdown, but LLMs don't always follow instructions perfectly. The finding regex needs to handle variations:

```typescript
// Both formats appear in practice:
// **[CRITICAL]** `file.ts:42`    (with brackets)
// **CRITICAL** `file.ts:42`      (without brackets)
const findingRegex = /\*\*\[?(CRITICAL|HIGH|MEDIUM|LOW)\]?\*\*\s*`([^`]+)`/g;
```

The `\[?` and `\]?` make brackets optional. Without this, half the findings were silently dropped.

Another subtlety: the regex-based parser uses `exec()` in a loop, which maintains `lastIndex` state. When we peek ahead for the next match to determine where a finding block ends, we need to reset `lastIndex` afterward. Miss this, and findings get merged or skipped.

## Gotcha #5: Shell Injection in CI Environments

The original code used `execSync()` to run git commands:

```typescript
// DANGEROUS in CI where branch names come from user input
execSync(`git diff origin/${targetBranch}...HEAD`);
```

If someone creates a branch named `main; rm -rf /`, this becomes a shell injection. In CI, branch names are attacker-controlled input.

**The fix:** Switch to `execFileSync()` with argument arrays. This calls the binary directly without shell interpretation:

```typescript
execFileSync('git', ['diff', '-U5', '--merge-base', `origin/${targetBranch}`]);
```

Similarly, the Gemini API key was originally passed as a URL query parameter. Moving it to the `x-goog-api-key` header prevents it from appearing in logs, proxy caches, and browser history.

## Gotcha #6: Large Diffs Blow Up CLI Arguments

Diffs can be huge. When passing a 100KB diff as a command-line argument to `gemini -p "..."`, you hit the OS argument length limit (`ARG_MAX`, typically 256KB on Linux but lower effective limits exist).

The fix is writing the prompt to a temporary file and using Gemini's `@filename` syntax:

```typescript
const tmpFile = path.join(os.tmpdir(), `niteni-review-${process.pid}-${Date.now()}.txt`);
fs.writeFileSync(tmpFile, prompt, 'utf-8');
try {
  spawnSync('gemini', ['-p', `@${tmpFile}`, '--sandbox'], { ... });
} finally {
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
}
```

The `finally` block ensures cleanup even if the command fails. The filename includes PID and timestamp to avoid collisions in parallel CI jobs.

## Gotcha #7: ReDoS in Glob Pattern Matching

The diff filter converts glob patterns like `*.min.js` into regex. The naive approach:

```typescript
// Original - vulnerable to ReDoS
pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
```

This escapes the `*` first, then tries to un-escape it. But it also escapes `.`, `+`, and other regex metacharacters that appear in filenames. The order of operations matters — escape everything *except* glob characters, then convert glob characters:

```typescript
const escaped = pattern
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex chars (NOT *)
  .replace(/\*/g, '.*')                    // convert glob * to regex .*
  .replace(/\?/g, '.');                    // convert glob ? to regex .
```

The difference is subtle but critical. The original version would double-escape patterns and produce incorrect matches.

## Gotcha #8: URL Encoding Everything Twice (or Not at All)

GitLab project IDs can contain slashes when using namespaced paths like `my-group/my-project`. These need to be URL-encoded in API paths. But if you encode a numeric project ID like `12345`, it stays the same. The code must handle both cases:

```typescript
const encodedProjectId = encodeURIComponent(this.projectId);
const url = new URL(`${this.apiUrl}/projects/${encodedProjectId}${path}`);
```

Every path parameter — MR IID, note ID, discussion ID, file paths, branch refs — gets `encodeURIComponent()`. It's tedious but necessary. A branch named `feature/auth` without encoding becomes a path traversal.

## Testing Without External Dependencies

The test suite uses Node's built-in `node:test` and `node:assert` modules. No Jest, no Mocha, no Vitest. This keeps the dependency tree at exactly two entries: `typescript` and `@types/node`.

```typescript
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
```

The simulation mode (`niteni --mode simulate`) uses hardcoded mock data that exercises the full parsing pipeline without making any API calls. It's both a demo tool and a manual integration test — you can see exactly what Niteni would post to GitLab.

## What I'd Do Differently

1. **Structured output from Gemini.** Instead of parsing markdown with regex, I'd use Gemini's JSON mode or function calling to get structured findings. The regex parser works but is inherently fragile.

2. **Rate limiting for large MRs.** Posting 20+ inline comments in rapid succession can hit GitLab's API rate limits. A simple delay between requests would help.

3. **Caching reviewed files.** If a file hasn't changed between pipeline runs, there's no need to re-review it. A SHA-based cache would cut token usage significantly.

4. **Better diff context.** The current approach sends raw diffs. Sending surrounding context (the full file, or at least more lines around changes) would give Gemini better understanding of the code.

## The Result

Niteni runs in about 30 seconds in CI, reviews diffs up to 100K characters, and posts findings with one-click suggestion buttons. It catches real bugs — SQL injections, missing auth middleware, hardcoded secrets, loose equality comparisons.

The zero-dependency approach paid off. Install is `git clone && npm ci && npm run build`. No native modules, no platform-specific binaries, no post-install scripts. It works on `node:20-alpine` with just `git` and `bash` added.

If you're interested in the code: [github.com/denyherianto/niteni](https://github.com/denyherianto/niteni)

---

*Built with TypeScript. Reviewed by Gemini. Named in Javanese.*
