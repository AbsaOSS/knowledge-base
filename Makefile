# Front door for the common tasks. The npm scripts stay the source of truth; every
# target here delegates to one, so CI and `npm run` keep working without make.
#
# Windows: make is not part of Git for Windows. Install it (`winget install
# ezwinports.make`) and run it from Git Bash. Recipes are POSIX sh.

SHELL := /bin/sh
.DEFAULT_GOAL := help

SEARCH_INDEX := dist/_mcp/search-index.json
IMAGE    ?= knowledge-base
PORT     ?= 8080
# `make prod HEADLESS=true` builds web-fragment output; KB_REGISTRY in the
# environment points the build at a deployment repo's registry.
HEADLESS ?= false

.PHONY: help install dev dev-headless mcp-dev mcp-stdio build build-local build-headless \
        fixture-build typecheck lint format test test-mcp test-standalone test-container \
        size image run prod clean

help: ## List targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z_-]+:.*## / { printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install dependencies from the lockfiles (root + actions/)
	npm ci
	npm ci --prefix actions

# ── Develop ────────────────────────────────────────────────────────────────

dev: ## Astro dev server, standalone (needs artifacts in apps/)
	npm run dev

dev-headless: ## Astro dev server, web-fragment mode
	npm run dev:headless

mcp-dev: $(SEARCH_INDEX) ## MCP over HTTP from source on :8081, restarting on change
	npm run mcp:dev

mcp-stdio: $(SEARCH_INDEX) ## MCP over stdio from source
	npm run mcp:stdio

# ── Build ──────────────────────────────────────────────────────────────────

build: ## Fetch Release artifacts and build (needs GITHUB_TOKEN or gh auth)
	npm run build

build-local: ## Build from local repos, no GitHub fetch
	npm run build:local

build-headless: ## Headless build from the current registry
	npm run build:headless

fixture-build: ## Hermetic headless build from the vendored test fixtures
	node scripts/setup-test-apps.mjs
	npm run build:headless

$(SEARCH_INDEX):
	$(MAKE) fixture-build

# ── Quality ────────────────────────────────────────────────────────────────

typecheck: ## Type-check the MCP server
	npm run typecheck

lint: ## Type-check, lint and check formatting
	npm run lint

format: ## Apply formatting and autofixable lint fixes
	npm run format

test: ## Full Playwright suite (builds the fixture itself)
	npm test

test-mcp: $(SEARCH_INDEX) ## MCP suites only, no browser harness (fast loop)
	npm run test:mcp

test-standalone: ## Fragment server suite
	npx playwright test --config=playwright.config.ci.js

test-container: ## Real nginx + Node image (needs Docker)
	npm run test:container

size: $(SEARCH_INDEX) ## Check the MCP server bundle against its size budget
	npm run test:mcp -- --grep "bundle budget"

# ── Ship ───────────────────────────────────────────────────────────────────

image: ## Build the production image from dist/
	docker build -t $(IMAGE) .

run: ## Serve the image on localhost (PORT=8080)
	docker run --rm -p $(PORT):8080 $(IMAGE)

prod: clean install ## Clean, install, strict production build, size check, image
	KB_STRICT=true node scripts/build-vite.js $(if $(filter true,$(HEADLESS)),--headless)
	$(MAKE) size
	$(MAKE) image

clean: ## Remove build output and test reports
	rm -rf dist apps public tmp test-results playwright-report .astro
