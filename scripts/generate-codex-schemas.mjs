import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const codexReleasePath = path.join(projectRoot, "apps/backend/src/codex-release.json");
const codexRelease = JSON.parse(readFileSync(codexReleasePath, "utf8"));
const pinnedVersion = codexRelease.codexVersion;
const pinnedSchemaVersion = codexRelease.schemaVersion;

const installedVersionOutput = execFileSync("codex", ["--version"], {
  cwd: projectRoot,
  encoding: "utf8"
}).trim();
const installedVersionMatch = installedVersionOutput.match(/(\d+\.\d+\.\d+)/);

if (!installedVersionMatch) {
  throw new Error(`Unable to parse installed Codex version from "${installedVersionOutput}"`);
}

const installedVersion = installedVersionMatch[1];

if (installedVersion !== pinnedVersion) {
  throw new Error(
    `Pinned Codex version is ${pinnedVersion}, but installed codex is ${installedVersion}.`
  );
}

const tsOutDir = path.join(projectRoot, "schemas/codex/ts");
const jsonOutDir = path.join(projectRoot, "schemas/codex/json");

mkdirSync(tsOutDir, { recursive: true });
mkdirSync(jsonOutDir, { recursive: true });

execFileSync("codex", ["app-server", "generate-ts", "--experimental", "--out", tsOutDir], {
  cwd: projectRoot,
  stdio: "inherit"
});
execFileSync(
  "codex",
  ["app-server", "generate-json-schema", "--experimental", "--out", jsonOutDir],
  {
    cwd: projectRoot,
    stdio: "inherit"
  }
);

writeFileSync(
  path.join(projectRoot, "schemas/codex/metadata.json"),
  `${JSON.stringify(
    {
      codexVersion: pinnedVersion,
      schemaVersion: pinnedSchemaVersion,
      generatedAt: new Date().toISOString(),
      commands: [
        "codex app-server generate-ts --experimental --out schemas/codex/ts",
        "codex app-server generate-json-schema --experimental --out schemas/codex/json"
      ]
    },
    null,
    2
  )}\n`
);

console.log(`Generated Codex schema artifacts for pinned version ${pinnedVersion}`);
