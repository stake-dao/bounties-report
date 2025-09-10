# SDPENDLE Delegators APR Automation

.PHONY: help
help:
	@echo "SDPENDLE Delegators APR automation"
	@echo ""
	@echo "Available targets:"
	@echo "  make run-apr         - Compute SDPENDLE delegators APR for current week"
	@echo "  make run-apr-week    - Compute SDPENDLE delegators APR for specific week (WEEK=timestamp)"
	@echo ""

# Get current week timestamp
CURRENT_WEEK := $(shell node -e "console.log(Math.floor(Date.now() / 1000 / 604800) * 604800)")

# Allow override with WEEK environment variable
WEEK ?= $(CURRENT_WEEK)

.PHONY: run-apr
run-apr:
	@echo "Computing SDPENDLE delegators APR for current week..."
	@npx ts-node script/helpers/computeSdPendleDelegatorsAPR.ts

.PHONY: run-apr-week
run-apr-week:
	@echo "Computing SDPENDLE delegators APR for week $(WEEK)..."
	@npx ts-node script/helpers/computeSdPendleDelegatorsAPR.ts $(WEEK)