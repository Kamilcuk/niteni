# Niteni

> *Niteni* (Javanese: to observe carefully, to pay close attention)

AI-powered code review for GitLab CI pipelines, powered by [Gemini CLI Code Review Extension](https://github.com/gemini-cli-extensions/code-review).

Uses the Gemini CLI `/code-review` command to analyze code changes on your current branch for quality issues, then posts structured findings as GitLab MR notes.

## How It Works

This package uses a **cascading review strategy**:

1. **Gemini REST API** (preferred) — Calls the Gemini API directly with a structured prompt for reliable, formatted output
2. **Gemini CLI `/code-review` extension** — Falls back to the CLI extension which runs `git diff` internally
3. **Gemini CLI with direct prompt** — Final fallback passing the diff directly to `gemini -p`

The extension is auto-installed if Gemini CLI is available but the extension is not yet present.

## Features

- **Inline diff comments** — Findings are posted directly on the changed lines in the MR diff
- **Severity-based emojis** — :rotating_light: CRITICAL, :warning: HIGH, :large_blue_circle: MEDIUM, :information_source: LOW
- **GitLab suggestion blocks** — One-click "Apply suggestion" for each code fix
- **Rationale explanations** — Each suggestion includes why the change is recommended
- Cascading fallback strategy (REST API -> CLI extension -> CLI prompt)
- Auto-installs the Gemini CLI code-review extension when available
- Automatic cleanup of previous review comments on re-review
- Configurable file filtering (include/exclude patterns)
- Diff size limits to manage token usage
- Optional pipeline failure on CRITICAL findings

## Quick Start

### 1. Set up CI/CD Variables

In your GitLab project, go to **Settings > CI/CD > Variables** and add:

| Variable | Description | Required |
|----------|-------------|----------|
| `GEMINI_API_KEY` | Google Gemini API key | Yes |
| `GITLAB_TOKEN` | GitLab access token with `api` scope | Yes |

### 2. Add to your `.gitlab-ci.yml`

```yaml
niteni-code-review:
  stage: review
  image: node:20-alpine
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  before_script:
    - apk add --no-cache git curl bash
    # Clone and build Niteni
    - git clone https://github.com/denyherianto/niteni.git /tmp/niteni
    - cd /tmp/niteni && npm ci && npm run build && npm link
    - cd $CI_PROJECT_DIR
  script:
    - niteni --mode mr
  allow_failure: true
```

> **Note:** Do NOT re-declare `GEMINI_API_KEY` or `GITLAB_TOKEN` in the job `variables:` section — this causes a circular reference. Project-level CI/CD variables are automatically available in all jobs.

### 3. Or install as a dependency

```bash
npm install niteni
```

```typescript
import { runMergeRequestReview, Reviewer } from 'niteni';

// Run full MR review (requires env vars)
const result = await runMergeRequestReview();

// Or use the Reviewer class directly
const reviewer = new Reviewer({ geminiApiKey: 'your-key' });
const review = await reviewer.review(diffContent);
```

## Gemini CLI /code-review Extension

This package leverages the [code-review extension](https://github.com/gemini-cli-extensions/code-review) for Gemini CLI.

### What the extension does

The `/code-review` command:
- Runs `git diff -U5 --merge-base origin/HEAD` to retrieve changes on the current branch
- Analyzes diffs as a Principal Software Engineer
- Classifies issues by severity (CRITICAL, HIGH, MEDIUM, LOW)
- Only comments on actual changed lines (`+` or `-`)
- Provides file-by-file findings with line numbers and code suggestions

### Prerequisites

- [Gemini CLI](https://github.com/anthropics/gemini-cli) v0.4.0 or newer
- A valid `GEMINI_API_KEY`

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | - | Gemini API key |
| `GITLAB_TOKEN` | `$CI_JOB_TOKEN` | GitLab access token |
| `CI_PROJECT_ID` | - | GitLab project ID (auto-set in CI) |
| `CI_MERGE_REQUEST_IID` | - | MR IID (auto-set in CI) |
| `GEMINI_MODEL` | `gemini-3-pro-preview` | Gemini model (used for API fallback) |
| `REVIEW_MAX_FILES` | `50` | Max files to review |
| `REVIEW_MAX_DIFF_SIZE` | `100000` | Max diff size (characters) |
| `REVIEW_INCLUDE_PATTERNS` | - | File patterns to include (comma-separated) |
| `REVIEW_EXCLUDE_PATTERNS` | `package-lock.json,yarn.lock,*.min.js,*.min.css` | File patterns to exclude |
| `REVIEW_POST_AS_NOTE` | `true` | Post review as MR note |
| `REVIEW_FAIL_ON_CRITICAL` | `false` | Fail pipeline on CRITICAL findings |

## CLI Usage

```bash
# Review a GitLab merge request
niteni --mode mr

# Review local diff against target branch
GEMINI_API_KEY=your-key niteni --mode diff

# Run simulation with sample diff and mock review
niteni --mode simulate

# Show help
niteni --help
```

## Review Output

Findings are posted as **inline diff comments** directly on the changed lines. Each comment includes:

- Severity badge with emoji
- Issue description
- Suggestion with rationale explanation
- GitLab "Apply suggestion" button for one-click fixes

### Severity Levels

- :rotating_light: **CRITICAL** — Security vulnerabilities, data loss, logic failures
- :warning: **HIGH** — Performance bottlenecks, architectural violations, functional bugs
- :large_blue_circle: **MEDIUM** — Input validation gaps, error handling issues
- :information_source: **LOW** — Documentation, minor readability issues

### Example Inline Comment

> #### :warning: HIGH — `src/auth.js:42`
>
> **Issue:** Missing token expiration check allows indefinite session reuse.
>
> **Suggestion:** Adding an expiration check prevents stolen tokens from being used indefinitely.
> ```suggestion
> if (decoded.exp < Date.now() / 1000) {
>   throw new AuthError('Token expired');
> }
> ```

## Publishing to GitLab NPM Registry

The package auto-publishes on version tags:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The `publish-package` CI job will publish to your project's NPM registry.

### Manual publishing

```bash
# Configure registry
npm config set registry https://gitlab.com/api/v4/projects/YOUR_PROJECT_ID/packages/npm/
npm config set -- '//gitlab.com/api/v4/projects/YOUR_PROJECT_ID/packages/npm/:_authToken' "YOUR_TOKEN"

# Publish
npm publish
```

## Project Structure

```
niteni/
├── src/
│   ├── types/
│   │   ├── index.ts          # Barrel export for all types
│   │   ├── config.ts         # AppConfig, GitLabConfig, GeminiConfig, ReviewConfig
│   │   ├── gitlab.ts         # MergeRequest, MergeRequestNote, DiffPosition, etc.
│   │   └── reviewer.ts       # Severity, Finding, ReviewerOptions, FilterOptions
│   ├── index.ts              # Main module & orchestration
│   ├── cli.ts                # CLI entry point
│   ├── simulate.ts           # Simulation mode with mock data
│   ├── reviewer.ts           # Gemini CLI /code-review + fallback logic
│   ├── gitlab-api.ts         # GitLab API client
│   └── config.ts             # Configuration values
├── dist/                     # Compiled output (generated)
├── scripts/
│   └── ci-review.sh          # CI helper script
├── .gitlab-ci.yml            # GitLab CI pipeline
├── tsconfig.json             # TypeScript configuration
├── .npmrc                    # NPM registry config
├── package.json
└── README.md
```

## Vibecoding Prompt

Copy the prompt below into your AI coding tool (Claude Code, Cursor, GitHub Copilot, Windsurf, etc.) to integrate Niteni into your GitLab repository:

```
Integrate "Niteni" — an AI-powered code review tool — into this GitLab repository. Niteni uses the Gemini CLI /code-review extension to automatically review merge request diffs and post findings as MR notes.

## Steps

1. Add a `niteni` job to `.gitlab-ci.yml` that runs on merge request events:

   niteni-code-review:
     stage: review
     image: node:20-alpine
     rules:
       - if: $CI_PIPELINE_SOURCE == "merge_request_event"
     before_script:
       - apk add --no-cache git curl bash
       - git clone https://github.com/denyherianto/niteni.git /tmp/niteni
       - cd /tmp/niteni && npm ci && npm run build && npm link
       - cd $CI_PROJECT_DIR
     script:
       - niteni --mode mr
     allow_failure: true

   IMPORTANT: Do NOT re-declare GEMINI_API_KEY or GITLAB_TOKEN in the job `variables:` section.
   Project-level CI/CD variables are automatically available in all jobs. Re-declaring them
   causes a circular reference where the variable expands to a literal string instead of its value.

2. Ensure the following CI/CD variables are configured in GitLab (Settings > CI/CD > Variables).
   Set them as type "Variable" (not "File"), check "Mask variable", and UNCHECK "Protect variable":
   - GEMINI_API_KEY — Google Gemini API key
   - GITLAB_TOKEN — GitLab Personal Access Token with `api` scope

3. Optional environment variables (these CAN be added to the job `variables:` section since they are plain values, not references):
   - GEMINI_MODEL (default: gemini-3-pro-preview) — Gemini model for API fallback
   - REVIEW_MAX_FILES (default: 50) — Max files to include in the review
   - REVIEW_MAX_DIFF_SIZE (default: 100000) — Max diff size in characters
   - REVIEW_INCLUDE_PATTERNS — Comma-separated glob patterns to include (e.g. "src/**,lib/**")
   - REVIEW_EXCLUDE_PATTERNS — Comma-separated glob patterns to exclude
   - REVIEW_POST_AS_NOTE (default: true) — Post review as MR note
   - REVIEW_FAIL_ON_CRITICAL (default: false) — Fail the pipeline when CRITICAL findings are found

4. If the existing `.gitlab-ci.yml` does not have a `review` stage, add it to the `stages` list.

5. Test the integration by opening a merge request. Niteni will automatically review the diff and post a comment with severity-classified findings (CRITICAL, HIGH, MEDIUM, LOW) and suggested code fixes.
```

## License

MIT
