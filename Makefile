SHELL := /bin/bash

PNPM := corepack pnpm
COMPOSE := docker compose

.PHONY: help install build lint test typecheck dev start db-up db-down db-logs migrate seed-dev-data compose-up compose-down compose-logs smoke clean build-sandbox-agent e2b-build e2b-build-codex e2b-build-all license-check

help:
	@echo "Available targets:"
	@echo "  install              Install workspace dependencies"
	@echo "  build                Build all workspace packages"
	@echo "  lint                 Run ESLint across the repo"
	@echo "  test                 Run package tests if present, then typecheck"
	@echo "  typecheck            Run TypeScript checks across the workspace"
	@echo "  db-up                Start local PostgreSQL with Docker Compose"
	@echo "  db-down              Stop local PostgreSQL"
	@echo "  db-logs              Tail PostgreSQL logs"
	@echo "  migrate              Run backend database migrations"
	@echo "  seed-dev-data        Insert dummy users + 90 days of token usage for dashboard dev"
	@echo "  compose-up           Build and start the full local/dev stack"
	@echo "  compose-down         Stop the full local/dev stack"
	@echo "  compose-logs         Tail logs for the full local/dev stack"
	@echo "  smoke                Run the live local/dev smoke test against the API"
	@echo "  dev                  Start Postgres, run migrations, then start the frontend and backend in dev mode"
	@echo "  start                Start PostgreSQL, run migrations, then start dev servers"
	@echo "  clean                Remove local build outputs"
	@echo "  build-sandbox-agent  Verify the in-sandbox Claude harness exists"
	@echo "  e2b-build            Build and publish the unified agent-runtime E2B template (hosts Codex + Claude)"
	@echo "  e2b-build-codex      Alias for e2b-build"
	@echo "  e2b-build-all        Alias for e2b-build"

install:
	$(PNPM) install

build:
	$(PNPM) build

lint:
	$(PNPM) lint

test:
	$(PNPM) -r --if-present test
	$(PNPM) typecheck

typecheck:
	$(PNPM) typecheck

db-up:
	$(COMPOSE) up -d postgres

db-down:
	$(COMPOSE) down

db-logs:
	$(COMPOSE) logs -f postgres

migrate:
	$(PNPM) db:migrate

seed-dev-data:
	$(PNPM) --filter @cogniplane/backend db:seed-dev

compose-up:
	$(COMPOSE) up --build

compose-down:
	$(COMPOSE) down

compose-logs:
	$(COMPOSE) logs -f frontend backend postgres

smoke:
	$(PNPM) test:e2e:local

dev:
	$(COMPOSE) up -d postgres
	@echo "Waiting for postgres to be healthy..."
	@until docker inspect --format='{{.State.Health.Status}}' cogniplane-postgres 2>/dev/null | grep -q healthy; do sleep 1; done
	$(PNPM) db:migrate
	$(PNPM) dev

start:
	$(MAKE) dev

# Optional local extensions. The `-include` directive ignores the file
# silently if it does not exist.
-include Makefile.local

# The sandbox-agent harness is a hand-written .mjs file at
# docker/sandbox-agent/sandbox-agent.mjs. No bundling is needed; the Claude
# SDK is installed globally inside the template and resolved via NODE_PATH.
build-sandbox-agent:
	@test -f docker/sandbox-agent/sandbox-agent.mjs || (echo "ERROR: docker/sandbox-agent/sandbox-agent.mjs is missing" >&2; exit 1)
	@echo "sandbox-agent.mjs ready"

# Builds the unified agent-runtime E2B template using the v2 Template SDK
# (docker/template.ts + docker/build.prod.ts).
e2b-build: build-sandbox-agent
	cd docker && npx tsx build.prod.ts

e2b-build-codex: e2b-build
e2b-build-all: e2b-build

license-check:
	npx tsx scripts/license-check.ts

clean:
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
	rm -rf apps/*/.next apps/*/dist packages/*/dist
