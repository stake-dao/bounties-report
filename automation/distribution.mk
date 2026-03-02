include automation/setup/dotenv.mk
include automation/setup/node.mk

# Protocol parameter: vlAURA or vlCVX (required)
PROTOCOL ?=

# Merkle type for vlCVX: non-delegators or delegators (optional, defaults to non-delegators)
TYPE ?= non-delegators

.PHONY: all setup install-deps run-repartition run-merkle run-all \
        validate-reports verify-claims commit-and-push clean

.DEFAULT_GOAL := all

# --- Protocol-specific script paths ---

ifeq ($(PROTOCOL),vlAURA)
  REPART_SCRIPT    = script/vlAURA/2_repartition/index.ts
  MERKLE_SCRIPT    = script/vlAURA/3_merkles/createMerkle.ts
  PROTOCOL_LABEL   = vlAURA
else ifeq ($(PROTOCOL),vlCVX)
  REPART_SCRIPT    = script/vlCVX/2_repartition/index.ts
  VERIFY_SCRIPT    = script/vlCVX/verify/claimsCompleteness.ts
  PROTOCOL_LABEL   = vlCVX
  ifeq ($(TYPE),delegators)
    MERKLE_SCRIPT  = script/vlCVX/3_merkles/createDelegatorsMerkle.ts
  else
    MERKLE_SCRIPT  = script/vlCVX/3_merkles/createCombinedMerkle.ts
  endif
else
  $(error PROTOCOL must be set to vlAURA or vlCVX)
endif

# --- Default target ---

ifeq ($(PROTOCOL),vlAURA)
  all: setup install-deps run-repartition run-merkle
else ifeq ($(PROTOCOL),vlCVX)
  all: setup install-deps validate-reports run-repartition
endif

# --- Common targets ---

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-repartition: setup install-deps
	@echo "Generating $(PROTOCOL_LABEL) repartition..."
	@$(PNPM) tsx $(REPART_SCRIPT)

run-merkle: setup install-deps
	@echo "Generating $(PROTOCOL_LABEL) merkle ($(TYPE))..."
	@$(PNPM) tsx $(MERKLE_SCRIPT)

# Alias: run-merkles maps to run-merkle (backward compat for vlCVX workflows)
run-merkles: run-merkle

run-all: run-repartition run-merkle
	@echo "$(PROTOCOL_LABEL) distribution pipeline complete"

# --- vlCVX-specific targets ---

validate-reports:
ifeq ($(PROTOCOL),vlCVX)
	@echo "Validating report CSVs exist..."
	@WEEK=$$(expr $$(date +%s) / 604800 \* 604800) && \
	CVX_FILE="bounties-reports/$$WEEK/cvx.csv" && \
	FXN_FILE="bounties-reports/$$WEEK/cvx_fxn.csv" && \
	if [ ! -f "$$CVX_FILE" ] && [ ! -f "$$FXN_FILE" ]; then \
		echo "ERROR: No report files found (cvx.csv or cvx_fxn.csv). Run reports.yaml first."; \
		exit 1; \
	fi && \
	CVX_LINES=0 && \
	FXN_LINES=0 && \
	if [ -f "$$CVX_FILE" ]; then \
		CVX_LINES=$$(tail -n +2 "$$CVX_FILE" | grep -v '^$$' | wc -l); \
	fi && \
	if [ -f "$$FXN_FILE" ]; then \
		FXN_LINES=$$(tail -n +2 "$$FXN_FILE" | grep -v '^$$' | wc -l); \
	fi && \
	TOTAL_LINES=$$(expr $$CVX_LINES + $$FXN_LINES) && \
	echo "Found $$CVX_LINES rewards in cvx.csv and $$FXN_LINES rewards in cvx_fxn.csv (Total: $$TOTAL_LINES)" && \
	if [ $$TOTAL_LINES -eq 0 ]; then \
		echo "ERROR: No rewards found in either cvx.csv or cvx_fxn.csv - stopping execution"; \
		exit 1; \
	fi && \
	echo "Validation passed: Found $$TOTAL_LINES total rewards"
endif

verify-claims: setup install-deps
ifeq ($(PROTOCOL),vlCVX)
	@echo "Verifying claims completeness..."
	@$(PNPM) tsx $(VERIFY_SCRIPT) || \
	(echo "Claims verification failed! Fix missing claims before generating merkles." && exit 1)
endif

# --- Git operations ---

commit-and-push:
	@echo "Committing and pushing changes..."
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add bounties-reports
	@git commit -m "Add $(PROTOCOL_LABEL) distribution" || true
	@git pull --rebase origin main
	@git push

# --- Cleanup ---

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node
