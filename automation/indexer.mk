include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-weekly get-forwarders clean

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps get-delegators

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

get-delegators: setup install-deps
	@echo "Running vlCVX delegation data collection..."
	@$(PNPM) tsx script/indexer/delegators.ts

get-forwarders: setup install-deps
	@echo "Running Votium forwarders indexing..."
	@$(PNPM) tsx script/indexer/forwarders.ts

commit-and-push:
	@echo "Committing and pushing changes..."
	@git config --global user.name 'github-actions[bot]'
	@git config --global user.email 'github-actions[bot]@users.noreply.github.com'
	@git stash
	@git pull --rebase origin main
	@git stash pop || true
	@if git diff --quiet data/delegations/ 2>/dev/null; then \
		echo "No changes to commit"; \
		exit 0; \
	fi
	@git add data/delegations/* 2>/dev/null || true
	@git commit -m "Update delegation data [$(shell date +%Y-%m-%d)]" || true
	@# Same retry as .github/actions/commit-and-push: a transient GitHub 5xx on
	@# push must not throw away the indexed data.
	@for attempt in 1 2 3; do \
		if git push origin main; then exit 0; fi; \
		if [ "$$attempt" -eq 3 ]; then echo "git push failed after 3 attempts" >&2; exit 1; fi; \
		echo "git push failed (attempt $$attempt/3); rebasing before retry" >&2; \
		sleep $$((attempt * 10)); \
		git pull --rebase origin main || true; \
	done

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node
