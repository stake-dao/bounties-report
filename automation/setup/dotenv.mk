# Check if .env file exists
ifneq (,$(wildcard .env))
    # Check if dotenv command is available
    ifeq ($(shell which dotenv),)
        # If dotenv is not available, use shell to export variables
        include .env
        export $(shell sed 's/=.*//' .env)
    else
        # If dotenv is available, use it to load variables
        include .env
        export $(shell dotenv list)
    endif
else
    $(warning No .env file found, environment variables may be missing)
endif