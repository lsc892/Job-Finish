// Run Codex 0.160.0 `app-server generate-ts --experimental --out .generated/codex160` first.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
const roots = ['InitializeParams', 'v2/ThreadStartParams', 'v2/ThreadResumeParams', 'v2/TurnStartParams',
  'v2/Thread', 'v2/Turn', 'v2/ToolRequestUserInputParams', 'v2/CommandExecutionRequestApprovalParams',
  'v2/FileChangeRequestApprovalParams', 'v2/ToolRequestUserInputResponse',
  'v2/PermissionsRequestApprovalParams', 'v2/PermissionsRequestApprovalResponse',
  'v2/ThreadTurnsListParams', 'v2/ThreadTurnsListResponse', 'v2/ThreadItemsListParams', 'v2/ThreadItemsListResponse'];
const source = process.argv[2] ?? '.generated/codex160';
const seen = new Set();
function copy(name) {
  name = normalize(name); if (seen.has(name)) return; seen.add(name);
  const body = readFileSync(join(source, name + '.ts'), 'utf8');
  const dest = join('src/protocol', name + '.ts'); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, body);
  for (const match of body.matchAll(/from "([^"]+)"/g)) copy(join(dirname(name), match[1]));
}
roots.forEach(copy);
console.log(`Copied ${seen.size} generated protocol types`);
