#!/usr/bin/env bash
set -euo pipefail

output=$(realpath -m "${1:?Supply an output directory}")
[[ ${BUILD_SHA:?} =~ ^[0-9a-f]{40}$ ]]
test "$(git rev-parse HEAD)" = "$BUILD_SHA"
test ! -e "$output"
mkdir -p "$output/workers/frontend" "$output/workers/sandbox"
export RELEASE_OUTPUT="$output"

docker save "cogniplane-backend:qa-$BUILD_SHA" | gzip -1 > "$output/backend.tar.gz"
export BACKEND_IMAGE_ID
BACKEND_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "cogniplane-backend:qa-$BUILD_SHA")

(
  cd apps/frontend
  pnpm exec wrangler deploy --dry-run --env-file /dev/null --outdir "$output/workers/frontend"
  pnpm exec wrangler deploy --config wrangler.sandbox.jsonc --dry-run --env-file /dev/null --outdir "$output/workers/sandbox"
  cp -a .open-next/assets "$output/workers/frontend/assets"
)
tar -C "$output/workers" -czf "$output/workers.tar.gz" frontend sandbox
python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path

output = Path(os.environ['RELEASE_OUTPUT'])
manifest = {
    'schema': 1,
    'sha': os.environ['BUILD_SHA'],
    'build_run_id': int(os.environ['GITHUB_RUN_ID']),
    'source_ci_run_id': int(os.environ['SOURCE_CI_RUN_ID']),
    'backend_image_id': os.environ['BACKEND_IMAGE_ID'],
    'files': {},
}
for name in ['backend.tar.gz', 'workers.tar.gz']:
    with (output / name).open('rb') as stream:
        manifest['files'][name] = hashlib.file_digest(stream, 'sha256').hexdigest()
(output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
