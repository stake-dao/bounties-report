include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-merkles-delegators run-merkles-non-delegators clean

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps run-merkles-non-delegators

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-merkles-delegators: setup install-deps
	@echo "Running merkles generation for delegators..."
	@$(PNPM) tsx script/vlCVX/3_merkles.ts --delegators

run-merkles-non-delegators: setup install-deps
	@echo "Running merkles generation for non-delegators..."
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