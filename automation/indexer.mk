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
	@git add .
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add data/delegations/*
	@git commit -m "Update delegation data" || true
	@git push

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node