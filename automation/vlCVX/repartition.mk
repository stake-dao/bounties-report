include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-claims run-weekly clean

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps validate-reports run-repartition

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-claims: setup install-deps
	@echo "Generating vlCVX Votemarket V2 claims..."
	@$(PNPM) tsx script/vlCVX/claims/generateConvexVotemarketV2.ts

run-report: setup install-deps
	@echo "Running report generation..."
	@$(PNPM) tsx script/vlCVX/1_report.ts

validate-reports: run-report
	@echo "Validating generated reports..."
	@WEEK=$$(expr $$(date +%s) / 604800 \* 604800) && \
	CVX_FILE="bounties-reports/$$WEEK/cvx.csv" && \
	FXN_FILE="bounties-reports/$$WEEK/cvx_fxn.csv" && \
	if [ ! -f "$$CVX_FILE" ] && [ ! -f "$$FXN_FILE" ]; then \
		echo "ERROR: No report files found (cvx.csv or cvx_fxn.csv)"; \
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
	echo "✓ Validation passed: Found $$TOTAL_LINES total rewards"

run-repartition: validate-reports setup install-deps
	@echo "Running repartition generation..."
	@$(PNPM) tsx script/vlCVX/2_repartition/index.ts

commit-and-push:
	@echo "Committing and pushing changes..."
	@git add .
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add bounties-reports
	@git commit -m "Add vlCVX report + repartition" || true
	@git pull --rebase origin main
	@git push

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node