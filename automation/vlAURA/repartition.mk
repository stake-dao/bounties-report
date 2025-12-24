include automation/setup/dotenv.mk

.PHONY: run-claims run-report run-repartition run-merkle run-all

run-claims:
	@echo "Generating vlAURA Votemarket claims..."
	npx ts-node script/vlAURA/claims/generateVotemarketV2.ts

run-report:
	@echo "Generating vlAURA report..."
	npx ts-node script/vlAURA/1_report.ts

run-repartition:
	@echo "Generating vlAURA repartition..."
	npx ts-node script/vlAURA/2_repartition/index.ts

run-merkle:
	@echo "Generating vlAURA merkle..."
	npx ts-node script/vlAURA/3_merkles/createMerkle.ts

run-all: run-claims run-report run-repartition run-merkle
	@echo "vlAURA distribution pipeline complete"
