include automation/setup/dotenv.mk
include automation/setup/node.mk

.PHONY: all setup install-deps \
        run-weekly-curve run-weekly-balancer run-weekly-fxn run-weekly-frax run-weekly-pendle \
        run-otc-curve run-otc-balancer run-otc-fxn run-otc-frax run-otc-pendle \
        clean

.DEFAULT_GOAL := all

all: setup install-deps

setup: setup-node

install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx

# Weekly reports
run-weekly-curve: setup install-deps
	@echo "Generating Curve weekly report..."
	@$(PNPM) tsx script/reports/generateReport.ts curve

run-weekly-balancer: setup install-deps
	@echo "Generating Balancer weekly report..."
	@$(PNPM) tsx script/reports/generateReport.ts balancer

run-weekly-fxn: setup install-deps
	@echo "Generating FXN weekly report..."
	@$(PNPM) tsx script/reports/generateReport.ts fxn

run-weekly-frax: setup install-deps
	@echo "Generating Frax weekly report..."
	@$(PNPM) tsx script/reports/generateReportFrax.ts

run-weekly-pendle: setup install-deps
	@echo "Generating Pendle weekly report..."
	@$(PNPM) tsx script/reports/generatePendleReport.ts
	@$(PNPM) tsx script/reports/generateReport.ts pendle

# OTC reports
run-otc-curve: setup install-deps
	@echo "Generating Curve OTC report..."
	@$(PNPM) tsx script/reports/generateOTCReport.ts curve

run-otc-balancer: setup install-deps
	@echo "Generating Balancer OTC report..."
	@$(PNPM) tsx script/reports/generateOTCReport.ts balancer

run-otc-fxn: setup install-deps
	@echo "Generating FXN OTC report..."
	@$(PNPM) tsx script/reports/generateOTCReport.ts fxn

run-otc-frax: setup install-deps
	@echo "Generating Frax OTC report..."
	@$(PNPM) tsx script/reports/generateOTCReport.ts frax

run-otc-pendle: setup install-deps
	@echo "Generating Pendle OTC report..."
	@$(PNPM) tsx script/reports/generateOTCReport.ts pendle

clean:
	@echo "Cleaning up local files..."
	@rm -rf node_modules
	@$(MAKE) -f automation/setup/node.mk clean-node
