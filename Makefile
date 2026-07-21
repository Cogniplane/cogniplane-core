SHELL := /bin/bash

PNPM := corepack pnpm
COMPOSE := docker compose

.PHONY: help install build lint test typecheck dev start db-up db-down db-logs migrate seed-dev-data compose-up compose-down compose-logs smoke clean e2b-build license-check

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
	@echo "  e2b-build            Build the Deep Agents code-execution E2B template"

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

# Builds the Deep Agents code-execution E2B template (docker/template.ts +
# docker/build.ts) using the v2 Template SDK. Wire the printed id via
# E2B_TEMPLATE_ID.
e2b-build:
	cd docker && npx tsx build.ts

license-check:
	npx tsx scripts/license-check.ts

clean:
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
	rm -rf apps/*/.next apps/*/dist packages/*/dist
