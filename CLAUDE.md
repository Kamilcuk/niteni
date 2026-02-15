# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Niteni is an AI-powered code review tool for GitLab CI pipelines, powered by Google's Gemini API. The name comes from Javanese, meaning "to observe carefully." It posts inline diff comments with suggestions directly on GitLab merge requests.

**Zero external runtime dependencies** — only uses Node.js built-in modules (`https`, `child_process`, `fs`, `path`, `os`, `url`) plus TypeScript for compilation.

## Commands

```bash
npm run build              # Compile TypeScript (tsc)
npm run dev                # Watch mode compilation
npm run lint               # ESLint on src/
npm run test               # Node built-in test runner (dist/**/*.test.js) — build first
npm run review:simulate    # Run simulation mode with mock data (needs ts-node)
npm run simulate           # Run simulation from compiled output
```

Tests use Node's built-in `node:test` and `node:assert` modules. Run `npm run build && npm test` to compile and execute tests from `dist/**/*.test.js`.

## Architecture

```
src/
├── cli.ts          # CLI entry point — three modes: mr, diff, simulate
├── index.ts        # Main orchestration: runMergeRequestReview() & runDiffReview()
├── reviewer.ts     # Gemini review logic with cascading fallback strategy
├── gitlab-api.ts   # GitLab REST API client (MR data, inline comments, cleanup)
├── config.ts       # Environment variable parsing & validation
├── simulate.ts     # Self-contained demo with ANSI-colored mock output
└── types/
    ├── index.ts    # Barrel export
    ├── config.ts   # AppConfig, GitLabConfig, GeminiConfig, ReviewConfig
    ├── gitlab.ts   # MergeRequest, DiffPosition, MergeRequestNote
    └── reviewer.ts # Severity, Finding, ReviewResult, FilterOptions
```

### Cascading Review Strategy (reviewer.ts)

The `Reviewer` class tries three strategies in order, falling back on failure:
1. **Gemini REST API** — direct HTTP call to `generativelanguage.googleapis.com`
2. **Gemini CLI `/code-review` extension** — invokes `gemini` CLI tool
3. **Gemini CLI with direct prompt** — passes diff content as a prompt

### MR Review Flow (index.ts)

`runMergeRequestReview()`: Fetch MR metadata → get diffs → filter by include/exclude patterns → run cascading review → parse findings with regex → clean up old review comments → post inline diff comments with severity emojis and suggestion blocks.

### GitLab API Client (gitlab-api.ts)

Supports three auth modes via `GITLAB_TOKEN`: `PRIVATE-TOKEN`, `JOB-TOKEN` (CI default via `$CI_JOB_TOKEN`), and `Bearer` (OAuth). Uses Node.js `https` module directly.

### Review Output Format

Findings are parsed with regex from structured markdown. Each finding has: severity (`CRITICAL`|`HIGH`|`MEDIUM`|`LOW`), file path, line number, description, optional suggestion block, and rationale.

## Key Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | Required | Google Gemini API key |
| `GITLAB_TOKEN` | `$CI_JOB_TOKEN` | GitLab auth token |
| `GEMINI_MODEL` | `gemini-3-pro-preview` | Model for REST API |
| `REVIEW_MAX_FILES` | `50` | Max files to review |
| `REVIEW_MAX_DIFF_SIZE` | `100000` | Max diff size in chars |
| `REVIEW_INCLUDE_PATTERNS` | — | Comma-separated glob patterns to include |
| `REVIEW_EXCLUDE_PATTERNS` | `package-lock.json,...` | Comma-separated glob patterns to exclude |
| `REVIEW_FAIL_ON_CRITICAL` | `false` | Exit 1 on CRITICAL findings |

## TypeScript Configuration

- Target: ES2022, Module: CommonJS
- Strict mode enabled
- Source maps and declaration files generated
- Output directory: `dist/`
