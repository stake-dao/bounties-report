include automation/setup/python.mk

# Node.js configuration
NODE_VERSION := 22.23.4
PNPM_VERSION := 10.33.0
NODEENV_DIR := $(shell pwd)/temp/.nodeenv-$(NODE_VERSION)

# Opt in only after the caller has prepared Node/pnpm and installed dependencies.
CI_SETUP_DONE ?= 0

.PHONY: setup-node install-deps clean-node

ifeq ($(CI_SETUP_DONE),1)
NODE := node
PNPM := pnpm

setup-node install-deps:
else
NODE := $(NODEENV_DIR)/bin/node
PNPM := $(NODEENV_DIR)/bin/pnpm

setup-node: setup-python $(NODE)

$(NODE): $(VENV_DIR)/bin/activate
	@if [ ! -f "$(NODE)" ]; then \
		echo "Setting up Node.js $(NODE_VERSION) virtual environment..."; \
		. $(VENV_DIR)/bin/activate && nodeenv --node=$(NODE_VERSION) --npm=none $(NODEENV_DIR); \
		. $(NODEENV_DIR)/bin/activate && npm install -g pnpm@$(PNPM_VERSION); \
	else \
		echo "Node.js $(NODE_VERSION) virtual environment already exists. Skipping setup."; \
	fi

install-deps: setup-node
	@echo "Installing dependencies..."
	@$(PNPM) install --frozen-lockfile
endif

clean-node:
	@echo "Cleaning up Node.js virtual environment..."
	rm -rf $(NODEENV_DIR)
	@echo "Node.js cleanup completed."
