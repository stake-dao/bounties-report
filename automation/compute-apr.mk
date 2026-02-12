include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-vlcvx-apr run-vlaura-apr clean

.DEFAULT_GOAL := all

WEEK := $(shell expr $$(date +%s) / 604800 \* 604800)

all: setup install-deps

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-vlcvx-apr: setup install-deps
	@echo "Computing vlCVX delegation APR..."
	@$(PNPM) tsx script/helpers/computevlCVXDelegatorsAPR.ts
	@mkdir -p bounties-reports/latest/vlCVX
	@if [ -f "bounties-reports/$(WEEK)/vlCVX/APRs.json" ]; then \
		cp "bounties-reports/$(WEEK)/vlCVX/APRs.json" "bounties-reports/latest/vlCVX/APRs.json"; \
		echo "Copied APRs.json to latest/vlCVX/"; \
	fi

run-vlaura-apr: setup install-deps
	@echo "Computing vlAURA delegation APR..."
	@$(PNPM) tsx script/helpers/computevlAURADelegatorsAPR.ts
	@mkdir -p bounties-reports/latest/vlAURA
	@if [ -f "bounties-reports/$(WEEK)/vlAURA/APRs.json" ]; then \
		cp "bounties-reports/$(WEEK)/vlAURA/APRs.json" "bounties-reports/latest/vlAURA/APRs.json"; \
		echo "Copied APRs.json to latest/vlAURA/"; \
	fi

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node
