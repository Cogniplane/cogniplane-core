SHELL := /bin/bash

PNPM := corepack pnpm
COMPOSE := docker compose

.PHONY: help install build lint test typecheck dev start db-up db-down db-logs migrate seed-dev-data compose-up compose-down compose-logs smoke clean e2b-build license-check

help:
	@echo "Available targets:"
	@echo "  install              Install workspace dependencies"
	@echo "  build                Build all workspace packages"
	@echo "  lint                 Run ESLint across the repo"
	@echo "  test                 Run the root Vitest suite, then typecheck"
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
	$(PNPM) test:all
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

# Postgres-backed RLS suite. Needs a database; without INTEGRATION_DATABASE_URL
# the project skips itself, which is why it is not part of `make test`.
#
# The DSN is a SUPERUSER connection to the SERVER, not to the `cogniplane`
# database. Each run creates its own throwaway database AND its own throwaway
# role, then drops both, so it never touches your dev data or the `app_user`
# password a running backend is using. (Roles are cluster-wide, which is why
# the role is per-run too.)
#
# Override the DSN to point at a Postgres you already have, e.g. when 5432 is
# taken:
#   make test-integration INTEGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres
INTEGRATION_DATABASE_URL ?= postgres://postgres:postgres@localhost:5432/postgres

# Seconds to wait for the container health check before giving up.
INTEGRATION_DB_WAIT_S ?= 60

test-integration:
ifeq ($(INTEGRATION_DATABASE_URL),postgres://postgres:postgres@localhost:5432/postgres)
	$(COMPOSE) up -d postgres
	@echo "Waiting for postgres to be healthy (up to $(INTEGRATION_DB_WAIT_S)s)..."
	@attempt=0; \
	until [ "$$(docker inspect --format='{{.State.Health.Status}}' cogniplane-postgres 2>/dev/null)" = "healthy" ]; do \
	  attempt=$$((attempt + 1)); \
	  if [ $$attempt -ge $(INTEGRATION_DB_WAIT_S) ]; then \
	    echo "cogniplane-postgres did not become healthy in $(INTEGRATION_DB_WAIT_S)s." >&2; \
	    echo "Most often port 5432 is already bound by another container or a local postgres." >&2; \
	    echo "Point the suite at that server instead:" >&2; \
	    echo "  make test-integration INTEGRATION_DATABASE_URL=postgres://user:pass@localhost:5432/postgres" >&2; \
	    echo "--- docker inspect ---" >&2; \
	    docker inspect --format='{{.State.Status}} {{.State.Health.Status}}' cogniplane-postgres >&2 || true; \
	    echo "--- last 20 log lines ---" >&2; \
	    $(COMPOSE) logs --tail=20 postgres >&2 || true; \
	    exit 1; \
	  fi; \
	  sleep 1; \
	done
endif
	INTEGRATION_DATABASE_URL=$(INTEGRATION_DATABASE_URL) $(PNPM) test:integration
