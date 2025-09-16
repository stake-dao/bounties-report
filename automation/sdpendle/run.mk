# SDPENDLE Delegators APR Automation

.PHONY: help
help:
	@echo "SDPENDLE Delegators APR automation"
	@echo ""
	@echo "Available targets:"
	@echo "  make run-apr         - Compute SDPENDLE delegators APR for current week"
	@echo "  make run-apr-week    - Compute SDPENDLE delegators APR for specific week (WEEK=timestamp)"
	@echo "  make commit-and-push - Commit and push changes (like Spectra)"
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

.PHONY: commit-and-push
commit-and-push:
	@echo "Committing and pushing SDPENDLE APR changes..."
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add bounties-reports/$(CURRENT_WEEK)/delegationsAPRs.json
	@git add delegationsAPRs.json || true
	@git commit -m "chore: Update SDPENDLE delegators APR" || true
	@git pull --rebase origin main || true
	@git push || true