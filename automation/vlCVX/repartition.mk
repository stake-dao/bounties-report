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

run-report: setup install-deps
	@echo "Running report generation..."
	@$(PNPM) tsx script/vlCVX/1_report.ts

run-repartition: setup install-deps
	@echo "Running repartition generation..."
	@$(PNPM) tsx script/vlCVX/2_repartition.ts

commit-and-push:
	@echo "Committing and pushing changes..."
	@git add .
	@git config --global user.name 'GitHub Action'
	@git config --global user.email 'action@github.com'
	@git add bounties-reports
	@git commit -m "Add vlCVX report + repartition" || true
	@git push

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node