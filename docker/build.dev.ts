import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Template, defaultBuildLogger } from 'e2b';
import { template } from './template';

if (!process.env.E2B_API_KEY) {
  try {
    const cfg = JSON.parse(
      readFileSync(`${process.env.HOME}/.e2b/config.json`, 'utf8')
    ) as { teamApiKey?: string };
    if (cfg.teamApiKey) process.env.E2B_API_KEY = cfg.teamApiKey;
  } catch {
    // No fallback available.
  }
}

async function main() {
  await Template.build(template, 'agent-runtime-dev-dev', {
    onBuildLogs: defaultBuildLogger()
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
