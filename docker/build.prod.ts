import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Template, defaultBuildLogger } from 'e2b';
import { template } from './template';

// E2B SDK reads E2B_API_KEY from env. Fall back to the CLI's stored team key
// at ~/.e2b/config.json so local builds work without additional setup — it's
// the same key `npx @e2b/cli template create` was using.
if (!process.env.E2B_API_KEY) {
  try {
    const cfg = JSON.parse(
      readFileSync(`${process.env.HOME}/.e2b/config.json`, 'utf8')
    ) as { teamApiKey?: string };
    if (cfg.teamApiKey) process.env.E2B_API_KEY = cfg.teamApiKey;
  } catch {
    // No fallback available — surface the SDK's own "missing API key" error.
  }
}

async function main() {
  await Template.build(template, 'agent-runtime-dev', {
    onBuildLogs: defaultBuildLogger()
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
