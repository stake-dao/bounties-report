include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-metadata clean

.DEFAULT_GOAL := all

all: setup install-deps run-metadata

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-metadata: setup install-deps
	@echo "Updating round metadata..."
	@$(PNPM) tsx script/helpers/getRoundMetadata.ts

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node
