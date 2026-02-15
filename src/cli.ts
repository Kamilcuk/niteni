#!/usr/bin/env node

import { runMergeRequestReview, runDiffReview } from './index';
import { runSimulation } from './simulate';

const args = process.argv.slice(2);
let mode = 'mr';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mode' && args[i + 1]) {
    mode = args[i + 1];
    i++;
  }
  if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Niteni - AI-powered code review for GitLab
(Javanese: to observe carefully, to pay close attention)

Usage:
  niteni [options]

Options:
  --mode <mr|diff|simulate>  Review mode (default: mr)
                             mr       - Review a GitLab merge request
                             diff     - Review local git diff against target branch
                             simulate - Run simulation with sample diff and mock review
  --help, -h                 Show this help message

Environment Variables:
  GEMINI_API_KEY                Gemini API key (required for mr/diff modes)
  GITLAB_TOKEN                  GitLab access token (required for MR mode)
  CI_PROJECT_ID                 GitLab project ID (required for MR mode)
  CI_MERGE_REQUEST_IID          Merge request IID (required for MR mode)
  CI_MERGE_REQUEST_TARGET_BRANCH_NAME  Target branch (default: main)
  GEMINI_MODEL                  Gemini model to use (default: gemini-3-pro-preview)
  REVIEW_MAX_FILES              Max files to review (default: 50)
  REVIEW_MAX_DIFF_SIZE          Max diff size in chars (default: 100000)
  REVIEW_INCLUDE_PATTERNS       Comma-separated file patterns to include
  REVIEW_EXCLUDE_PATTERNS       Comma-separated file patterns to exclude
  REVIEW_POST_AS_NOTE           Post review as MR note (default: true)
  REVIEW_FAIL_ON_CRITICAL       Exit with error on CRITICAL findings (default: false)

Examples:
  # Run simulation to see sample output
  niteni --mode simulate

  # Run in GitLab CI (MR mode, auto-configured)
  niteni

  # Run locally against target branch
  GEMINI_API_KEY=your-key niteni --mode diff

  # In .gitlab-ci.yml
  niteni:
    script:
      - npx niteni --mode mr
`);
    process.exit(0);
  }
}

async function main(): Promise<void> {
  try {
    let result;
    switch (mode) {
      case 'mr':
        result = await runMergeRequestReview();
        break;
      case 'diff':
        result = await runDiffReview();
        break;
      case 'simulate':
        result = await runSimulation();
        break;
      default:
        console.error(`Unknown mode: ${mode}. Use 'mr', 'diff', or 'simulate'.`);
        process.exit(1);
    }

    if (result.hasCritical && process.env.REVIEW_FAIL_ON_CRITICAL === 'true') {
      console.error('Failing pipeline due to CRITICAL findings.');
      process.exit(1);
    }
  } catch (err) {
    console.error('Review failed:', (err as Error).message);
    process.exit(1);
  }
}

main();
