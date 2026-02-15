import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import type { ReviewerOptions, FilterOptions, Finding, Severity } from './types';

export const REVIEW_PROMPT = `You are a Principal Software Engineer. Review the code diff below and respond ONLY with the structured format shown. Do NOT include any thinking, planning, or conversational text. Do NOT attempt to modify files or run commands. Just analyze and respond.

## Severity Levels
- **CRITICAL**: Security vulnerabilities, data loss, logic failures
- **HIGH**: Performance bottlenecks, architectural violations, functional bugs
- **MEDIUM**: Input validation gaps, error handling issues, naming problems
- **LOW**: Documentation improvements, minor readability issues

## Rules
- Only comment on changed lines (+ or - lines in the diff)
- Include precise line numbers and code suggestions
- Skip package-lock.json, yarn.lock, and minified files

## Required Output Format (follow EXACTLY)

### Summary
[1-2 sentence summary of what the changes do]

### Findings

**[SEVERITY]** \`filename:line_number\`
> Description of the issue
> Rationale: Brief explanation of why the suggested fix resolves this issue
\`\`\`suggestion
// suggested fix
\`\`\`

---

(Repeat for each finding. Separate findings with ---)

If no issues found, respond with:

### Summary
[summary]

### Findings
No significant issues found. The code changes look good.
`;

export class Reviewer {
  private geminiApiKey: string;
  private model: string;

  constructor({ geminiApiKey, model = 'gemini-3-pro-preview' }: ReviewerOptions) {
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

  private isStructuredReview(output: string): boolean {
    return /###\s*(Summary|Findings)/i.test(output) ||
           /\*\*\[?(CRITICAL|HIGH|MEDIUM|LOW)\]?\*\*/.test(output);
  }

  async reviewWithCodeReviewExtension(): Promise<string | null> {
    if (!this.ensureGeminiCli()) {
      console.log('Gemini CLI not available, skipping extension strategy.');
      return null;
    }

    if (!this.isCodeReviewExtensionInstalled()) {
      const installed = this.installCodeReviewExtension();
      if (!installed) {
        console.log('Code-review extension not available, skipping.');
        return null;
      }
    }

    console.log('[Strategy 1] Running Gemini CLI /code-review...');

    try {
      const result = spawnSync('gemini', ['-p', '/code-review', '--sandbox'], {
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

      if (!this.isStructuredReview(output)) {
        console.warn('Gemini CLI /code-review output is not in structured format, skipping.');
        return null;
      }

      console.log('[Strategy 1] Gemini CLI /code-review completed successfully.');
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

    console.log('[Strategy 2] Running Gemini CLI with direct prompt...');

    const tmpFile = path.join(os.tmpdir(), `niteni-review-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, `${REVIEW_PROMPT}\n\nHere is the diff to review:\n\n${diffContent}`, 'utf-8');

    try {
      const result = spawnSync('gemini', [
        '-p', `@${tmpFile}`,
        '--sandbox',
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

      const output = result.stdout.trim();
      if (!output) return null;

      if (!this.isStructuredReview(output)) {
        console.warn('Gemini CLI output is not in structured format, skipping.');
        return null;
      }

      console.log('[Strategy 2] Gemini CLI completed successfully.');
      return output;
    } catch (err) {
      console.error('Gemini CLI prompt execution failed:', (err as Error).message);
      return null;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    }
  }

  async reviewWithAPI(diffContent: string): Promise<string> {
    if (!/^[a-zA-Z0-9._-]+$/.test(this.model)) {
      throw new Error(`Invalid model name: ${this.model}`);
    }

    const body = JSON.stringify({
      systemInstruction: {
        parts: [{
          text: 'You are a code review tool. Output ONLY structured markdown in the exact format requested. Never include thinking, planning, or conversational text.',
        }],
      },
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
        path: `/v1beta/models/${this.model}:generateContent`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-goog-api-key': this.geminiApiKey,
        },
        rejectUnauthorized: true,
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

    // Strategy 1: Gemini REST API (most reliable — uses our structured prompt directly)
    console.log('[Strategy 1] Trying Gemini REST API...');
    try {
      const apiResult = await this.reviewWithAPI(diffContent);
      if (apiResult && this.isStructuredReview(apiResult)) {
        console.log('[Strategy 1] Gemini REST API completed successfully.');
        return apiResult;
      }
      console.warn('[Strategy 1] API response not in structured format.');
    } catch (err) {
      console.warn('[Strategy 1] Gemini REST API failed:', (err as Error).message);
    }

    // Strategy 2: Gemini CLI with /code-review extension
    const extensionResult = await this.reviewWithCodeReviewExtension();
    if (extensionResult) {
      return extensionResult;
    }

    // Strategy 3: Gemini CLI with diff as direct prompt
    const cliResult = await this.reviewWithGeminiCLI(diffContent);
    if (cliResult) {
      return cliResult;
    }

    throw new Error('All review strategies failed. Check GEMINI_API_KEY and network connectivity.');
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
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp('^' + escaped + '$');
    return regex.test(filePath) || filePath.endsWith(pattern.replace(/^\*/, ''));
  }

  parseFindings(reviewText: string): Finding[] {
    const findings: Finding[] = [];
    const findingRegex = /\*\*\[?(CRITICAL|HIGH|MEDIUM|LOW)\]?\*\*\s*`([^`]+)`/g;
    let match: RegExpExecArray | null;

    while ((match = findingRegex.exec(reviewText)) !== null) {
      const severity = match[1] as Severity;
      const location = match[2];
      const [file, line] = location.split(':');

      const startIdx = match.index + match[0].length;
      const nextMatch = findingRegex.exec(reviewText);
      const endIdx = nextMatch ? nextMatch.index : reviewText.length;
      findingRegex.lastIndex = match.index + match[0].length;

      const block = reviewText.substring(startIdx, endIdx);

      const description = block
        .replace(/^[\s>]+/, '')
        .trim();

      let suggestion: string | undefined;
      const suggestionMatch = block.match(/```suggestion\n([\s\S]*?)```/);
      if (suggestionMatch) {
        suggestion = suggestionMatch[1];
      }

      let rationale: string | undefined;
      const rationaleMatch = block.match(/Rationale:\s*(.+)/);
      if (rationaleMatch) {
        rationale = rationaleMatch[1].trim();
      }

      findings.push({
        severity,
        file: file || 'unknown',
        line: parseInt(line, 10) || 0,
        description,
        suggestion,
        rationale,
      });
    }

    return findings;
  }

  hasCriticalFindings(reviewText: string): boolean {
    return /\*\*\[?CRITICAL\]?\*\*/.test(reviewText);
  }
}
