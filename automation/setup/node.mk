include automation/setup/python.mk

# Node.js configuration
NODE_VERSION := 22.9.0
PNPM_VERSION := 8.15.4
NODEENV_DIR := $(shell pwd)/temp/.nodeenv
NODE := $(NODEENV_DIR)/bin/node
PNPM := $(NODEENV_DIR)/bin/pnpm

.PHONY: setup-node clean-node

setup-node: setup-python $(NODE)

$(NODE): $(VENV_DIR)/bin/activate
	@if [ ! -f "$(NODE)" ]; then \
		echo "Setting up Node.js $(NODE_VERSION) virtual environment..."; \
		. $(VENV_DIR)/bin/activate && nodeenv --node=$(NODE_VERSION) --npm=$(PNPM_VERSION) $(NODEENV_DIR); \
		. $(NODEENV_DIR)/bin/activate && npm install -g pnpm@$(PNPM_VERSION); \
	else \
		echo "Node.js $(NODE_VERSION) virtual environment already exists. Skipping setup."; \
	fi

clean-node:
	@echo "Cleaning up Node.js virtual environment..."
	rm -rf $(NODEENV_DIR)
	@echo "Node.js cleanup completed."