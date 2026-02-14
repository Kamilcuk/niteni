import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import type { ReviewerOptions, FilterOptions, Finding, Severity } from './types';

export const REVIEW_PROMPT = `You are a Principal Software Engineer performing a thorough code review.

Analyze the following code diff and provide a structured review.

## Review Guidelines

1. **Summarize** the change's intent in 1-2 sentences
2. **Prioritize** application code over test code
3. **Classify** issues by severity:
   - **CRITICAL**: Security vulnerabilities, data loss, logic failures
   - **HIGH**: Performance bottlenecks, architectural violations, functional bugs
   - **MEDIUM**: Input validation gaps, error handling issues, naming problems
   - **LOW**: Documentation improvements, minor readability issues

## Rules
- Only comment on actual changed lines (lines starting with + or -)
- Issues must demonstrate genuine bugs or significant improvements
- Avoid procedural language ("check," "verify," "ensure")
- Include precise line numbers and code suggestions
- Skip stylistic nitpicks unrelated to execution or readability
- Skip reviewing package-lock.json, yarn.lock, and minified files

## Output Format

Provide your review in the following structured format:

### Summary
[1-2 sentence summary of changes]

### Findings

For each issue found:

**[SEVERITY]** \`filename:line_number\`
> Description of the issue
\`\`\`suggestion
// suggested fix
\`\`\`

---

If no significant issues are found, respond with:
### Summary
[summary]

### Findings
No significant issues found. The code changes look good.
`;

export class Reviewer {
  private geminiApiKey: string;
  private model: string;

  constructor({ geminiApiKey, model = 'gemini-2.5-pro' }: ReviewerOptions) {
    this.geminiApiKey = geminiApiKey;
    this.model = model;
  }

  private isGeminiCliAvailable(): boolean {
    try {
      execSync('which gemini', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private installGeminiCli(): boolean {
    try {
      console.log('Installing Gemini CLI...');
      execSync('npm install -g @google/gemini-cli', { stdio: 'pipe', timeout: 120000 });
      console.log('Gemini CLI installed successfully.');
      return true;
    } catch (err) {
      console.warn('Failed to install Gemini CLI:', (err as Error).message);
      return false;
    }
  }

  private ensureGeminiCli(): boolean {
    if (this.isGeminiCliAvailable()) {
      return true;
    }
    return this.installGeminiCli() && this.isGeminiCliAvailable();
  }

  private isCodeReviewExtensionInstalled(): boolean {
    try {
      const home = os.homedir();
      const extensionsDir = path.join(home, '.gemini', 'extensions', 'code-review');
      return fs.existsSync(extensionsDir);
    } catch {
      return false;
    }
  }

  private installCodeReviewExtension(): boolean {
    try {
      console.log('Installing Gemini CLI code-review extension...');
      execSync(
        'gemini extensions install https://github.com/gemini-cli-extensions/code-review',
        { stdio: 'pipe', timeout: 60000 }
      );
      console.log('Code-review extension installed successfully.');
      return true;
    } catch (err) {
      console.warn('Failed to install code-review extension:', (err as Error).message);
      return false;
    }
  }

  async reviewWithCodeReviewExtension(): Promise<string | null> {
    if (!this.ensureGeminiCli()) {
      console.log('Gemini CLI not available, falling back to API mode...');
      return null;
    }

    if (!this.isCodeReviewExtensionInstalled()) {
      const installed = this.installCodeReviewExtension();
      if (!installed) {
        console.log('Code-review extension not available, falling back to API mode...');
        return null;
      }
    }

    console.log('Running Gemini CLI /code-review command...');

    try {
      const result = spawnSync('gemini', ['-p', '/code-review'], {
        env: {
          ...process.env,
          GEMINI_API_KEY: this.geminiApiKey,
        },
        encoding: 'utf-8',
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (result.status !== 0) {
        console.error('Gemini CLI /code-review error:', result.stderr);
        return null;
      }

      const output = result.stdout.trim();
      if (!output) {
        console.warn('Gemini CLI /code-review returned empty output.');
        return null;
      }

      console.log('Gemini CLI /code-review completed successfully.');
      return output;
    } catch (err) {
      console.error('Gemini CLI /code-review execution failed:', (err as Error).message);
      return null;
    }
  }

  async reviewWithGeminiCLI(diffContent: string): Promise<string | null> {
    if (!this.ensureGeminiCli()) {
      return null;
    }

    try {
      const result = spawnSync('gemini', [
        '-p', `${REVIEW_PROMPT}\n\nHere is the diff to review:\n\n${diffContent}`,
      ], {
        env: {
          ...process.env,
          GEMINI_API_KEY: this.geminiApiKey,
        },
        encoding: 'utf-8',
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (result.status !== 0) {
        console.error('Gemini CLI prompt error:', result.stderr);
        return null;
      }

      return result.stdout.trim() || null;
    } catch (err) {
      console.error('Gemini CLI prompt execution failed:', (err as Error).message);
      return null;
    }
  }

  async reviewWithAPI(diffContent: string): Promise<string> {
    const body = JSON.stringify({
      contents: [{
        parts: [{
          text: `${REVIEW_PROMPT}\n\nHere is the diff to review:\n\n${diffContent}`,
        }],
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
      },
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.candidates?.[0]) {
              resolve(parsed.candidates[0].content.parts[0].text);
            } else if (parsed.error) {
              reject(new Error(`Gemini API error: ${parsed.error.message}`));
            } else {
              reject(new Error('Unexpected Gemini API response'));
            }
          } catch (err) {
            reject(new Error(`Failed to parse Gemini response: ${(err as Error).message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async review(diffContent: string): Promise<string> {
    if (!diffContent || diffContent.trim().length === 0) {
      return 'No code changes to review.';
    }

    // Strategy 1: Use /code-review extension command
    const extensionResult = await this.reviewWithCodeReviewExtension();
    if (extensionResult) {
      return extensionResult;
    }

    // Strategy 2: Use Gemini CLI with diff as prompt
    console.log('Trying Gemini CLI with direct prompt...');
    const cliResult = await this.reviewWithGeminiCLI(diffContent);
    if (cliResult) {
      return cliResult;
    }

    // Strategy 3: Use Gemini REST API directly
    console.log('Falling back to Gemini REST API...');
    return this.reviewWithAPI(diffContent);
  }

  filterDiff(diffContent: string, { includePatterns, excludePatterns, maxDiffSize }: FilterOptions): string {
    if (!diffContent) return '';

    if (diffContent.length > maxDiffSize) {
      console.warn(`Diff size (${diffContent.length}) exceeds max (${maxDiffSize}), truncating...`);
      diffContent = diffContent.substring(0, maxDiffSize) + '\n\n... [diff truncated due to size]';
    }

    const excludes = excludePatterns
      ? excludePatterns.split(',').map(p => p.trim()).filter(Boolean)
      : [];

    const includes = includePatterns
      ? includePatterns.split(',').map(p => p.trim()).filter(Boolean)
      : [];

    if (excludes.length === 0 && includes.length === 0) {
      return diffContent;
    }

    const fileSections = diffContent.split(/^diff --git /m);
    const filtered = fileSections.filter((section) => {
      if (!section.trim()) return false;

      const fileMatch = section.match(/a\/(.+?) b\//);
      if (!fileMatch) return true;

      const filePath = fileMatch[1];

      for (const pattern of excludes) {
        if (this.matchPattern(filePath, pattern)) return false;
      }

      if (includes.length > 0) {
        return includes.some(pattern => this.matchPattern(filePath, pattern));
      }

      return true;
    });

    return filtered.map((s, i) => i === 0 ? s : `diff --git ${s}`).join('');
  }

  private matchPattern(filePath: string, pattern: string): boolean {
    const regex = new RegExp(
      '^' + pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') + '$'
    );
    return regex.test(filePath) || filePath.endsWith(pattern.replace(/^\*/, ''));
  }

  parseFindings(reviewText: string): Finding[] {
    const findings: Finding[] = [];
    const findingRegex = /\*\*\[(CRITICAL|HIGH|MEDIUM|LOW)\]\*\*\s*`([^`]+)`/g;
    let match: RegExpExecArray | null;

    while ((match = findingRegex.exec(reviewText)) !== null) {
      const severity = match[1] as Severity;
      const location = match[2];
      const [file, line] = location.split(':');

      const startIdx = match.index + match[0].length;
      const nextMatch = findingRegex.exec(reviewText);
      const endIdx = nextMatch ? nextMatch.index : reviewText.length;
      findingRegex.lastIndex = match.index + match[0].length;

      const description = reviewText
        .substring(startIdx, endIdx)
        .replace(/^[\s>]+/, '')
        .trim();

      findings.push({
        severity,
        file: file || 'unknown',
        line: parseInt(line, 10) || 0,
        description,
      });
    }

    return findings;
  }

  hasCriticalFindings(reviewText: string): boolean {
    return /\*\*\[CRITICAL\]\*\*/.test(reviewText);
  }
}
