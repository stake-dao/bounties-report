include automation/setup/dotenv.mk
include automation/setup/node.mk

# SDPENDLE Delegators APR Automation

.PHONY: all setup install-deps run-apr run-apr-week commit-and-push clean help

help:
	@echo "SDPENDLE Delegators APR automation"
	@echo ""
	@echo "Available targets:"
	@echo "  make run-apr         - Compute SDPENDLE delegators APR for current week"
	@echo "  make run-apr-week    - Compute SDPENDLE delegators APR for specific week (WEEK=timestamp)"
	@echo "  make commit-and-push - Commit and push changes (like Spectra)"
	@echo ""

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps run-apr

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

# Get current week timestamp
CURRENT_WEEK := $(shell node -e "console.log(Math.floor(Date.now() / 1000 / 604800) * 604800)")

# Allow override with WEEK environment variable
WEEK ?= $(CURRENT_WEEK)

run-apr: setup install-deps
	@echo "Computing SDPENDLE delegators APR for current week..."
	@$(PNPM) tsx script/helpers/computeSdPendleDelegatorsAPR.ts

run-apr-week: setup install-deps
	@echo "Computing SDPENDLE delegators APR for week $(WEEK)..."
	@$(PNPM) tsx script/helpers/computeSdPendleDelegatorsAPR.ts $(WEEK)

commit-and-push:
	@echo "Committing and pushing SDPENDLE APR changes..."
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add bounties-reports/$(CURRENT_WEEK)/delegationsAPRs.json
	@git commit -m "chore: Update SDPENDLE delegators APR" || true
	@git pull --rebase origin main || true
	@git push || true

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node
