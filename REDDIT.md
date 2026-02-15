# I built an AI code review bot for GitLab CI with zero runtime dependencies

I got tired of GitLab not having a built-in AI review feature like GitHub Copilot reviews, so I built one myself. It's called **Niteni** (Javanese for "to observe carefully") — it runs as a CI job, sends your MR diff to Google Gemini, and posts findings as **inline diff comments** with one-click "Apply suggestion" buttons.

**GitHub:** [github.com/denyherianto/niteni](https://github.com/denyherianto/niteni)

## What it does

- Runs in any GitLab CI pipeline on merge request events
- Sends the diff to Gemini and parses structured findings (CRITICAL / HIGH / MEDIUM / LOW)
- Posts each finding as an inline comment on the exact changed line
- Includes GitLab suggestion blocks so you can apply fixes with one click
- Cleans up old review comments on re-runs (no spam)
- Has a cascading fallback: REST API -> Gemini CLI extension -> Gemini CLI direct prompt

## The zero-dependency thing

The entire tool uses only Node.js built-ins (`https`, `child_process`, `fs`, `path`, `os`, `url`). No axios, no node-fetch, no octokit equivalent. The only devDependencies are `typescript` and `@types/node`.

Why? CI environments are ephemeral. Every `npm install` is wasted time. With this approach, setup is just `git clone && npm ci && npm run build`.

## Setup is ~10 lines of YAML

```yaml
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
```

## Things that surprised me during development

**GitLab CI variable circular references.** If you write `variables: { GITLAB_TOKEN: $GITLAB_TOKEN }` in your job, GitLab expands it to the literal string `$GITLAB_TOKEN` instead of the secret value. Project-level CI/CD variables are already available — re-declaring them creates a circular reference. This took me hours to figure out.

**Three different auth headers.** GitLab uses `PRIVATE-TOKEN` for personal tokens, `JOB-TOKEN` for CI job tokens, and `Authorization: Bearer` for OAuth. Using the wrong one silently returns 401s with unhelpful error messages.

**LLMs don't follow instructions consistently.** Gemini sometimes outputs `**[CRITICAL]**` and sometimes `**CRITICAL**` (no brackets). The finding parser regex needs `\[?` and `\]?` to handle both. Without this, half the findings were silently dropped.

**Shell injection via branch names.** Using `execSync(\`git diff origin/${branch}\`)` is a shell injection if someone names their branch `main; rm -rf /`. Switched to `execFileSync('git', ['diff', 'origin/' + branch])` which bypasses the shell entirely.

**Large diffs blow up CLI arguments.** OS has an `ARG_MAX` limit. For big diffs, I write the prompt to a temp file and use `gemini -p @/tmp/prompt.txt` instead of passing it inline.

## Tech stack

- TypeScript (ES2022, CommonJS)
- Node.js built-in `https` for all HTTP (GitLab API + Gemini API)
- Node.js built-in `node:test` for unit tests
- Google Gemini API (default model: gemini-3-pro-preview)

## What it catches

The simulation mode (`niteni --mode simulate`) shows a realistic example: SQL injections, hardcoded JWT secrets, missing auth middleware, loose equality for password comparison, missing transaction boundaries. It's the kind of stuff that slips through in busy PRs.

## What's next

- Structured JSON output from Gemini instead of regex-parsed markdown
- File-level caching to skip unchanged files on re-review
- Rate limiting for large MRs with 20+ findings
- Better diff context (sending more surrounding lines)

Would love feedback. Has anyone else built something similar for GitLab? The GitHub ecosystem has tons of AI review bots but GitLab feels underserved.
