# Niteni

> *Niteni* (Javanese: to observe carefully, to pay close attention)

AI-powered code review for GitLab CI pipelines, powered by the [Gemini REST API](https://ai.google.dev/gemini-api) and Google Cloud Vertex AI.

Analyzes code changes via the Gemini API with [structured output](https://ai.google.dev/gemini-api/docs/structured-output), then posts severity-classified findings as GitLab MR notes.

## How It Works

Niteni calls the **Gemini REST API** or **Vertex AI** with structured output (`responseSchema` + `responseMimeType: "application/json"`) to get typed JSON findings directly. Each finding includes severity, file, line, description, suggestion, and rationale, which Niteni posts as inline comments on the merge request.

## Features

- **Vertex AI Support** — Native authentication via `google-auth-library`.
- **Inline diff comments** — Findings are posted directly on the changed lines in the MR diff.
- **GitLab suggestion blocks** — One-click "Apply suggestion" for each code fix.
- **Docker Ready** — Official images published to GitHub Container Registry (GHCR).
- **Cleanup** — Automatically removes previous review comments on re-review.
- **Configurable** — File filtering, diff size limits, and severity thresholds.

## Quick Start (GitLab CI)

The easiest way to use Niteni is with the official Docker image.

### 1. Set up CI/CD Variables

In your GitLab project, go to **Settings > CI/CD > Variables** and add:

| Variable | Description | Required |
|----------|-------------|----------|
| `GOOGLE_API_KEY` | Google Gemini API key (for AI Studio) | Choice |
| `GOOGLE_PROJECT_ID` | GCP Project ID (for Vertex AI) | Choice |
| `GITLAB_TOKEN` | GitLab access token with `api` scope | Yes |

### 2. Add to your `.gitlab-ci.yml`

```yaml
niteni-review:
  stage: test
  image: ghcr.io/kamilcuk/niteni:main
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    # Optional configuration
    GEMINI_MODEL: "gemini-1.5-pro"
    REVIEW_FAIL_ON_CRITICAL: "true"
  script:
    - niteni --mode mr
  allow_failure: true
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_API_KEY` | - | Gemini API key (AI Studio) |
| `GOOGLE_PROJECT_ID`| - | GCP Project ID (Vertex AI) |
| `GOOGLE_REGION` | `us-central1`| GCP Region (Vertex AI) |
| `GITLAB_TOKEN` | - | GitLab access token |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Gemini model to use |
| `REVIEW_MAX_FILES` | `50` | Max files to review |
| `REVIEW_MAX_DIFF_SIZE` | `100000` | Max diff size (characters) |
| `REVIEW_INCLUDE_PATTERNS` | - | Patterns to include (comma-separated) |
| `REVIEW_EXCLUDE_PATTERNS` | `package-lock.json,yarn.lock,*.min.js,*.min.css` | Patterns to exclude |
| `REVIEW_FAIL_ON_CRITICAL` | `true` | Fail pipeline on CRITICAL findings |

## Local Development

```bash
git clone git@github.com:Kamilcuk/niteni.git
cd niteni
npm install
npm run build
# Run local diff review
GOOGLE_API_KEY=your-key niteni --mode diff
```

## Docker

Build locally:
```bash
docker build -t niteni .
docker run --rm -e GOOGLE_API_KEY=$KEY niteni --help
```
