include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-merkles clean

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps run-merkles

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-merkles: setup install-deps
	@echo "Running merkles generation..."
	@$(PNPM) tsx script/vlCVX/3_merkles.ts

commit-and-push:
	@echo "Committing and pushing changes..."
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add bounties-reports
	@git commit -m "Add vlCVX merkles" || true
	@git pull --rebase origin main
	@git push

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node