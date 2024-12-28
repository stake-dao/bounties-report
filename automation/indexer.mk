include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-weekly clean

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps get-delegators

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

get-delegators: setup install-deps
	@echo "Running weekly delegation data collection..."
	@$(PNPM) tsx script/indexer/delegators.ts

commit-and-push:
	@echo "Committing and pushing changes..."
	@git config --global user.name 'github-actions[bot]'
	@git config --global user.email 'github-actions[bot]@users.noreply.github.com'
	@git stash
	@git pull --rebase origin main
	@git stash pop
	@if git diff --quiet data/delegations/; then \
		echo "No changes to commit"; \
		exit 0; \
	fi
	@git add data/delegations/*
	@git commit -m "Update delegation data [$(shell date +%Y-%m-%d)]" || true
	@git push origin main

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node