include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-weekly clean

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps run-weekly

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-weekly: setup install-deps
	@echo "Running weekly bounty generation..."
	@$(PNPM) tsx script/sdTkns/generateBounties.ts 0
	@$(PNPM) tsx script/sdTkns/generateBSCBounties.ts 0
	@$(PNPM) tsx script/vlCVX/0_generateConvexBounties.ts 0

run-mainnet: setup install-deps
	@echo "Running mainnet bounty generation..."
	@$(PNPM) tsx script/sdTkns/generateBounties.ts $(PAST_WEEK)

run-bsc: setup install-deps
	@echo "Running BSC bounty generation..."
	@$(PNPM) tsx script/sdTkns/generateBSCBounties.ts $(PAST_WEEK)

commit-and-push:
	@echo "Committing and pushing changes..."
	@git add .
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add weekly-bounties
	@git commit -m "Update weekly bounties" || true
	@git push

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node