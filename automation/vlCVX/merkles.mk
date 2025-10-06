include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps verify-claims run-merkles clean

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps verify-claims run-merkles

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

# Verify claims completeness before generating merkles
verify-claims: setup install-deps
	@echo "🔍 Verifying claims completeness..."
	@$(PNPM) tsx script/vlCVX/verifyClaimsCompleteness.ts || \
	(echo "\n❌ Claims verification failed! Fix missing claims before generating merkles." && exit 1)

# Single target that handles both types based on TYPE parameter
run-merkles: verify-claims
	@echo "Running merkles generation..."
	@if [ "$(TYPE)" = "delegators" ]; then \
		echo "Generating delegators merkle..."; \
		$(PNPM) tsx script/vlCVX/3_merkles/createDelegatorsMerkle.ts; \
	else \
		echo "Generating non-delegators merkle..."; \
		$(PNPM) tsx script/vlCVX/3_merkles/createCombinedMerkle.ts; \
	fi

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