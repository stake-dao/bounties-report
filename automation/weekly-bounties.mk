include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-all run-votemarket run-votemarket-v2 run-warden run-hiddenhand run-bsc clean commit-and-push

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps run-all

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

# Run all protocols
run-all: run-votemarket run-votemarket-v2 run-warden run-hiddenhand

# Individual protocol targets for mainnet
run-votemarket: setup install-deps
	@echo "Running Votemarket V1 bounty generation..."
	@$(PNPM) tsx script/sdTkns/generateVotemarket.ts $(PAST_WEEK)

run-votemarket-v2: setup install-deps
	@echo "Running Votemarket V2 bounty generation..."
	@$(PNPM) tsx script/sdTkns/generateVotemarketV2.ts $(PAST_WEEK)

run-warden: setup install-deps
	@echo "Running Warden bounty generation..."
	@$(PNPM) tsx script/sdTkns/generateWarden.ts $(PAST_WEEK)

run-hiddenhand: setup install-deps
	@echo "Running Hidden Hand bounty generation..."
	@$(PNPM) tsx script/sdTkns/generateHiddenHand.ts $(PAST_WEEK)

# BSC specific target
run-bsc: setup install-deps
	@echo "Running BSC bounty generation..."
	@$(PNPM) tsx script/sdTkns/generateBSCBounties.ts $(PAST_WEEK)

# Legacy targets for backward compatibility
run-weekly: run-all run-bsc

run-mainnet: run-all

commit-and-push:
	@echo "Committing and pushing changes..."
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add weekly-bounties
	@git commit -m "Update weekly bounties" || true
	@git push

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node