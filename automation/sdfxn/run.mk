include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-merkle clean

.DEFAULT_GOAL := all

all: setup install-deps run-merkle

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-merkle: setup install-deps
	@echo "Running sdFXN universal merkle generation..."
	@$(PNPM) tsx script/sdTkns/generateUniversalMerkleFxn.ts

commit-and-push:
	@echo "Committing and pushing changes..."
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add bounties-reports
	@git commit -m "Add sdFXN universal merkle" || true
	@git pull --rebase origin main
	@git push

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node
