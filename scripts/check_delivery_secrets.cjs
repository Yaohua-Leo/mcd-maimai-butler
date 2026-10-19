// Reports paths/counts only. Never print matched credentials or file contents.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const staged = process.argv.includes('--staged');
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
  : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
const files = [...new Set(git(args).toString('utf8').split('\0').filter(Boolean))];
const secrets = Object.entries(process.env)
  .filter(([name, value]) => /(?:TOKEN|SECRET|API_KEY|PASSWORD|ENCRYPTION_KEY)$/i.test(name) && value.length >= 16)
  .map(([, value]) => Buffer.from(value));
const pattern = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKID[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{16,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const forbidden = /^(?:evidence\/|research\/|\.cloudbase\/|\.workbuddy\/|\.wechat-devtools-test\/|project\.private\.config\.json$|project\.config\.json$|stdout$|\.env(?:\.|$))|(?:^|\/)node_modules\//;
const findings = [];
const blockedPaths = [];
let filesChecked = 0;
for (const file of files) {
  if (forbidden.test(file)) blockedPaths.push(file);
  const absolute = path.join(root, file);
  if (!staged && (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())) continue;
  const content = staged ? git(['show', ':' + file]) : fs.readFileSync(absolute);
  filesChecked += 1;
  if (secrets.some(secret => content.includes(secret)) || pattern.test(content.toString('utf8'))) findings.push(file);
}
console.log(JSON.stringify({ mode: staged ? 'git-index' : 'public-candidates', filesChecked,
  exactTokenComparisonAvailable: Boolean(process.env.MCD_MCP_TOKEN), findings, blockedPaths }, null, 2));
if (!filesChecked || findings.length || blockedPaths.length) process.exitCode = 1;
