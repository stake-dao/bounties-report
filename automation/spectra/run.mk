include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps run-weekly clean

# Define the default target
.DEFAULT_GOAL := all

all: setup install-deps run-report run-repartition

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

run-all: setup install-deps
	@echo "Running report generation..."
	@$(PNPM) tsx script/spectra/1_report.ts
	@echo "Running repartition generation..."
	@$(PNPM) tsx script/spectra/2_repartition.ts
	@echo "Running repartition generation..."
	@$(PNPM) tsx script/spectra/3_merkles.ts

commit-and-push:
	@echo "Committing and pushing changes..."
	@git add .
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add bounties-reports
	@git add spectra_merkle.json
	@git add delegationsAPRs.json
	@git commit -m "Add Spectra report + repartition + merkle" || true
	@git pull --rebase origin main
	@git push

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node