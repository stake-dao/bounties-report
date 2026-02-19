include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-all \
       run-votemarket run-votemarket-v2 run-warden run-hiddenhand run-spectra \
       run-convex-votemarket-v2 run-convex-votium \
       run-aura-votemarket-v2 \
       clean commit-and-push

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps run-all

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

# Run all protocols
run-all: run-votemarket run-votemarket-v2 run-warden run-hiddenhand run-spectra

# Individual protocol targets for mainnet
run-votemarket: setup install-deps
	@echo "Running Votemarket V1 bounty generation..."
	@$(PNPM) tsx script/sdTkns/claims/generateVotemarket.ts $(PAST_WEEK)

run-votemarket-v2: setup install-deps
	@echo "Running Votemarket V2 bounty generation..."
	@$(PNPM) tsx script/sdTkns/claims/generateVotemarketV2.ts $(PAST_WEEK)

run-warden: setup install-deps
	@echo "Running Warden bounty generation..."
	@$(PNPM) tsx script/sdTkns/claims/generateWarden.ts $(PAST_WEEK)

run-hiddenhand: setup install-deps
	@echo "Running Hidden Hand bounty generation..."
	@$(PNPM) tsx script/sdTkns/claims/generateHiddenHand.ts $(PAST_WEEK)

run-spectra: setup install-deps
	@echo "Running Spectra bounty generation..."
	@$(PNPM) tsx script/sdTkns/claims/generateSpectra.ts $(PAST_WEEK)

# vlCVX targets
run-convex-votemarket-v2: setup install-deps
	@echo "Running vlCVX Votemarket V2 bounty generation..."
	@$(PNPM) tsx script/vlCVX/claims/generateConvexVotemarketV2.ts $(PAST_WEEK)

run-convex-votium: setup install-deps
	@echo "Running vlCVX Votium bounty generation..."
	@$(PNPM) tsx script/vlCVX/claims/generateConvexVotium.ts $(PAST_WEEK)

# vlAURA targets
run-aura-votemarket-v2: setup install-deps
	@echo "Running vlAURA Votemarket V2 bounty generation..."
	@$(PNPM) tsx script/vlAURA/claims/generateVotemarketV2.ts $(PAST_WEEK)

# Legacy targets for backward compatibility
run-weekly: run-all

run-mainnet: run-all

run-convex-v2: run-convex-votemarket-v2

commit-and-push:
	@echo "Committing and pushing changes..."
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add weekly-bounties
	@git commit -m "$(COMMIT_MSG)" || true
	@git pull --rebase origin main
	@git push

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node