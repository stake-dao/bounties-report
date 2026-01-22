include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-claims run-report run-repartition run-merkle run-all clean

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps run-report run-repartition run-merkle

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-claims: setup install-deps
	@echo "Generating vlAURA Votemarket V2 claims..."
	@$(PNPM) tsx script/vlAURA/claims/generateVotemarketV2.ts

run-report: setup install-deps
	@echo "Generating vlAURA report..."
	@$(PNPM) tsx script/vlAURA/1_report.ts

run-repartition: setup install-deps
	@echo "Generating vlAURA repartition..."
	@$(PNPM) tsx script/vlAURA/2_repartition/index.ts

run-merkle: setup install-deps
	@echo "Generating vlAURA merkle..."
	@$(PNPM) tsx script/vlAURA/3_merkles/createMerkle.ts

run-all: run-claims run-report run-repartition run-merkle
	@echo "vlAURA distribution pipeline complete"

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node
