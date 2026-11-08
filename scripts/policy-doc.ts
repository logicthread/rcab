/**
 * `pnpm policy:doc`        — regenerate docs/POLICY.md and the policy block of
 *                            infra/docker/env.example/api.env.example.
 * `pnpm policy:doc:check`  — fail (exit 1) if either committed file is stale.
 *
 * Sources: apps/api/src/config/policy/policy.schema.ts (server knobs),
 * apps/web/src/config/policy.ts and apps/driver-app/lib/core/config/policy.dart
 * (client knobs). RCAB-E8.S10.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareGenerated,
  parseDartPolicy,
  renderEnvBlock,
  renderPolicyDoc,
  spliceEnvBlock,
  webKnobs,
} from '../apps/api/src/config/policy/policy-doc';
import { WEB_POLICY, WEB_POLICY_META } from '../apps/web/src/config/policy';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(root, 'docs/POLICY.md');
const ENV_EXAMPLE = join(root, 'infra/docker/env.example/api.env.example');
const DART = join(root, 'apps/driver-app/lib/core/config/policy.dart');

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);

const doc =
  renderPolicyDoc({
    web: webKnobs(WEB_POLICY, WEB_POLICY_META),
    driver: parseDartPolicy(readFileSync(DART, 'utf8')),
  }) + '\n';
const envExample = spliceEnvBlock(read(ENV_EXAMPLE) ?? '', renderEnvBlock());

const outputs: [string, string][] = [
  [DOC, doc],
  [ENV_EXAMPLE, envExample],
];

if (process.argv.includes('--check')) {
  const problems = outputs
    .map(([path, expected]) => compareGenerated(relative(root, path), expected, read(path)))
    .filter((p): p is string => p !== null);
  if (problems.length > 0) {
    for (const p of problems) console.error(`policy:doc:check: ${p}`);
    console.error('Run `pnpm policy:doc` and commit the result.');
    process.exit(1);
  }
  console.log('policy:doc:check: docs/POLICY.md and api.env.example are up to date.');
} else {
  for (const [path, content] of outputs) {
    writeFileSync(path, content);
    console.log(`policy:doc: wrote ${relative(root, path)}`);
  }
}
