include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-verify clean

.DEFAULT_GOAL := all

PROTOCOL ?= curve

all: setup install-deps run-verify

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-verify: setup install-deps
	@echo "Verifying sdTokens reports for $(PROTOCOL)..."
	@$(PNPM) tsx script/repartition/sdTkns/reportVerifier.ts $(PROTOCOL)

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node
