import { Reviewer } from './reviewer';
import type { ReviewResult } from './types';

const SAMPLE_DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1,6 +1,8 @@
 import { Request, Response } from 'express';
 import { db } from '../database';
+import jwt from 'jsonwebtoken';

 export async function loginHandler(req: Request, res: Response) {
-  const { username, password } = req.body;
+  const username = req.body.username;
+  const password = req.body.password;

@@ -12,8 +14,15 @@
   const user = await db.query('SELECT * FROM users WHERE username = "' + username + '"');

   if (!user) {
     return res.status(401).json({ error: 'Invalid credentials' });
   }

-  if (user.password === password) {
-    return res.json({ token: 'abc123', user });
+  if (user.password == password) {
+    const token = jwt.sign(
+      { userId: user.id, role: user.role },
+      'my-secret-key-123',
+      {}
+    );
+    return res.json({ token, user });
   }
+
+  return res.status(401).json({ error: 'Invalid credentials' });
 }
diff --git a/src/api/users.ts b/src/api/users.ts
--- a/src/api/users.ts
+++ b/src/api/users.ts
@@ -1,5 +1,6 @@
 import { Router } from 'express';
 import { db } from '../database';
+import { authMiddleware } from '../auth/middleware';

 const router = Router();

@@ -10,6 +11,20 @@
   res.json(users);
 });

+router.delete('/users/:id', async (req, res) => {
+  const userId = req.params.id;
+  await db.query(\`DELETE FROM users WHERE id = \${userId}\`);
+  await db.query(\`DELETE FROM sessions WHERE user_id = \${userId}\`);
+  await db.query(\`DELETE FROM audit_log WHERE user_id = \${userId}\`);
+  res.json({ success: true });
+});
+
+router.put('/users/:id/role', async (req, res) => {
+  const { role } = req.body;
+  await db.query(\`UPDATE users SET role = '\${role}' WHERE id = \${req.params.id}\`);
+  res.json({ success: true });
+});
+
 export default router;
diff --git a/src/utils/cache.ts b/src/utils/cache.ts
--- /dev/null
+++ b/src/utils/cache.ts
@@ -0,0 +1,25 @@
+const cache: Record<string, { data: any; expires: number }> = {};
+
+export function setCache(key: string, data: any, ttlMs: number = 300000) {
+  cache[key] = {
+    data,
+    expires: Date.now() + ttlMs,
+  };
+}
+
+export function getCache(key: string): any {
+  const entry = cache[key];
+  if (!entry) return null;
+
+  if (Date.now() > entry.expires) {
+    delete cache[key];
+    return null;
+  }
+
+  return entry.data;
+}
+
+export function clearCache() {
+  for (const key in cache) {
+    delete cache[key];
+  }
+}
`;

const MOCK_REVIEW_RESULT = `### Summary
Adds JWT-based authentication to the login flow, a user deletion endpoint, a role update endpoint, and an in-memory cache utility. Several changes introduce serious security vulnerabilities.

### Findings

**[CRITICAL]** \`src/auth/login.ts:14\`
> SQL injection vulnerability. User input is directly concatenated into the SQL query string without parameterization or escaping.
\`\`\`suggestion
const user = await db.query('SELECT * FROM users WHERE username = $1', [username]);
\`\`\`

---

**[CRITICAL]** \`src/auth/login.ts:22\`
> JWT secret is hardcoded as a plaintext string. This exposes the signing key in source control and allows anyone with repository access to forge tokens.
\`\`\`suggestion
const token = jwt.sign(
  { userId: user.id, role: user.role },
  process.env.JWT_SECRET!,
  { expiresIn: '24h' }
);
\`\`\`

---

**[HIGH]** \`src/auth/login.ts:20\`
> Loose equality (\`==\`) used for password comparison. Passwords should be hashed and compared using a timing-safe comparison function, not compared as plaintext.
\`\`\`suggestion
import bcrypt from 'bcrypt';
// ...
const isValid = await bcrypt.compare(password, user.password_hash);
if (isValid) {
\`\`\`

---

**[HIGH]** \`src/auth/login.ts:23\`
> JWT token has no expiration set. Without an \`expiresIn\` claim, tokens are valid indefinitely, meaning a stolen token can never be revoked by time alone.
\`\`\`suggestion
const token = jwt.sign(
  { userId: user.id, role: user.role },
  process.env.JWT_SECRET!,
  { expiresIn: '24h' }
);
\`\`\`

---

**[CRITICAL]** \`src/api/users.ts:14\`
> SQL injection in DELETE endpoint. The \`userId\` parameter is interpolated directly into three SQL queries without parameterization.
\`\`\`suggestion
await db.query('DELETE FROM users WHERE id = $1', [userId]);
await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
await db.query('DELETE FROM audit_log WHERE user_id = $1', [userId]);
\`\`\`

---

**[HIGH]** \`src/api/users.ts:13\`
> The delete endpoint has no authentication middleware. Any unauthenticated user can delete arbitrary accounts.
\`\`\`suggestion
router.delete('/users/:id', authMiddleware, async (req, res) => {
\`\`\`

---

**[CRITICAL]** \`src/api/users.ts:21\`
> SQL injection in role update endpoint. The \`role\` value from the request body is interpolated directly into the query, allowing privilege escalation or data exfiltration.
\`\`\`suggestion
await db.query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);
\`\`\`

---

**[HIGH]** \`src/api/users.ts:20\`
> The role update endpoint has no authorization check. Any user can change any other user's role, including escalating their own privileges to admin.
\`\`\`suggestion
router.put('/users/:id/role', authMiddleware, requireRole('admin'), async (req, res) => {
\`\`\`

---

**[MEDIUM]** \`src/api/users.ts:14\`
> User deletion is not wrapped in a transaction. If the second or third DELETE fails, the database is left in an inconsistent state with orphaned records.
\`\`\`suggestion
await db.transaction(async (trx) => {
  await trx.query('DELETE FROM audit_log WHERE user_id = $1', [userId]);
  await trx.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  await trx.query('DELETE FROM users WHERE id = $1', [userId]);
});
\`\`\`

---

**[MEDIUM]** \`src/utils/cache.ts:1\`
> In-memory cache uses \`any\` type for stored data and return values, losing all type safety. Consider using a generic type parameter.
\`\`\`suggestion
const cache: Record<string, { data: unknown; expires: number }> = {};

export function setCache<T>(key: string, data: T, ttlMs: number = 300000): void {
  cache[key] = { data, expires: Date.now() + ttlMs };
}

export function getCache<T>(key: string): T | null {
\`\`\`

---

**[LOW]** \`src/utils/cache.ts:22\`
> \`clearCache\` iterates with \`for...in\` and deletes keys individually. Reassigning to an empty object is simpler and faster.
\`\`\`suggestion
export function clearCache(): void {
  Object.keys(cache).forEach(key => delete cache[key]);
}
\`\`\``;

const REVIEW_HEADER = '<!-- niteni-review -->';
const BOT_SIGNATURE = '\n\n---\n*Reviewed by [Niteni](https://github.com/denyherianto/niteni) — AI-powered code review powered by [Gemini CLI](https://github.com/gemini-cli-extensions/code-review)*';

function severityColor(severity: string): string {
  switch (severity) {
    case 'CRITICAL': return '\x1b[31m';
    case 'HIGH':     return '\x1b[33m';
    case 'MEDIUM':   return '\x1b[36m';
    case 'LOW':      return '\x1b[37m';
    default:         return '\x1b[0m';
  }
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';

export async function runSimulation(): Promise<ReviewResult> {
  const reviewer = new Reviewer({ geminiApiKey: 'simulated-key' });

  console.log(`\n${BOLD}${'='.repeat(60)}${RESET}`);
  console.log(`${BOLD}  Niteni - Simulation Mode${RESET}`);
  console.log(`${DIM}  "to observe carefully" (Javanese)${RESET}`);
  console.log(`${BOLD}${'='.repeat(60)}${RESET}\n`);

  console.log(`${DIM}Simulating MR review with mock data...${RESET}\n`);

  console.log(`${BLUE}Project:${RESET}  my-group/my-app (ID: 12345)`);
  console.log(`${BLUE}MR:${RESET}      !42 - Add user authentication and management`);
  console.log(`${BLUE}Source:${RESET}   feature/auth -> main`);
  console.log(`${BLUE}Author:${RESET}   developer@example.com`);
  console.log(`${BLUE}Changes:${RESET}  3 file(s)\n`);

  console.log(`${BOLD}--- Diff Input ---${RESET}\n`);

  const diffLines = SAMPLE_DIFF.split('\n');
  for (const line of diffLines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      console.log(`${GREEN}${line}${RESET}`);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      console.log(`\x1b[31m${line}${RESET}`);
    } else if (line.startsWith('diff --git')) {
      console.log(`\n${BOLD}${line}${RESET}`);
    } else if (line.startsWith('@@')) {
      console.log(`${MAGENTA}${line}${RESET}`);
    } else {
      console.log(`${DIM}${line}${RESET}`);
    }
  }

  console.log(`\n${BOLD}--- Filter ---${RESET}\n`);
  const filteredDiff = reviewer.filterDiff(SAMPLE_DIFF, {
    includePatterns: '',
    excludePatterns: 'package-lock.json,yarn.lock,*.min.js,*.min.css',
    maxDiffSize: 100000,
  });
  console.log(`${DIM}Diff size: ${filteredDiff.length} characters${RESET}`);
  console.log(`${DIM}Excluded patterns: package-lock.json, yarn.lock, *.min.js, *.min.css${RESET}`);
  console.log(`${GREEN}All 3 files pass filter.${RESET}`);

  console.log(`\n${BOLD}--- Gemini CLI /code-review ---${RESET}\n`);
  console.log(`${DIM}[SIM] Gemini CLI not available, using mock response...${RESET}`);

  await new Promise(resolve => setTimeout(resolve, 500));

  console.log(`\n${BOLD}${'='.repeat(60)}${RESET}`);
  console.log(`${BOLD}  Review Results${RESET}`);
  console.log(`${BOLD}${'='.repeat(60)}${RESET}\n`);

  console.log(MOCK_REVIEW_RESULT);

  const findings = reviewer.parseFindings(MOCK_REVIEW_RESULT);
  const hasCritical = reviewer.hasCriticalFindings(MOCK_REVIEW_RESULT);

  console.log(`\n${BOLD}${'='.repeat(60)}${RESET}`);
  console.log(`${BOLD}  Findings Summary${RESET}`);
  console.log(`${BOLD}${'='.repeat(60)}${RESET}\n`);

  const countBySeverity: Record<string, number> = {};
  for (const f of findings) {
    countBySeverity[f.severity] = (countBySeverity[f.severity] || 0) + 1;
  }

  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    const count = countBySeverity[sev] || 0;
    if (count > 0) {
      console.log(`  ${severityColor(sev)}${BOLD}${sev}${RESET}: ${count}`);
    }
  }
  console.log(`  ${DIM}TOTAL${RESET}:    ${findings.length}\n`);

  console.log(`${BOLD}  Parsed Findings:${RESET}\n`);
  for (const f of findings) {
    console.log(`  ${severityColor(f.severity)}[${f.severity}]${RESET} ${f.file}:${f.line}`);
  }

  console.log(`\n${BOLD}${'='.repeat(60)}${RESET}`);
  console.log(`${BOLD}  GitLab MR Note Preview${RESET}`);
  console.log(`${BOLD}${'='.repeat(60)}${RESET}\n`);

  const noteBody = `${REVIEW_HEADER}\n\n## Niteni - Code Review\n\n${MOCK_REVIEW_RESULT}${BOT_SIGNATURE}`;
  console.log(`${DIM}--- Note body (${noteBody.length} chars) ---${RESET}\n`);
  console.log(noteBody);

  console.log(`\n${BOLD}${'='.repeat(60)}${RESET}`);
  console.log(`${BOLD}  Pipeline Result${RESET}`);
  console.log(`${BOLD}${'='.repeat(60)}${RESET}\n`);

  if (hasCritical) {
    console.log(`  ${severityColor('CRITICAL')}${BOLD}CRITICAL issues found!${RESET}`);
    console.log(`  ${DIM}REVIEW_FAIL_ON_CRITICAL=true  -> Pipeline would FAIL${RESET}`);
    console.log(`  ${DIM}REVIEW_FAIL_ON_CRITICAL=false -> Pipeline would PASS (allow_failure)${RESET}`);
  } else {
    console.log(`  ${GREEN}${BOLD}No critical issues. Pipeline PASS.${RESET}`);
  }

  console.log(`\n${DIM}[SIM] No actual API calls were made. This was a simulation.${RESET}\n`);

  return { review: MOCK_REVIEW_RESULT, hasCritical };
}
