include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-votium clean

.DEFAULT_GOAL := all

PAST_WEEK ?= 0

all: setup install-deps run-votium

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-votium: setup install-deps
	@echo "Generating Convex Votium claims..."
	@$(PNPM) tsx script/vlCVX/claims/generateConvexVotium.ts $(PAST_WEEK)

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node
