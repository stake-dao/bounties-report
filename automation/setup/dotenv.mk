# Check if .env file exists
ifneq (,$(wildcard .env))
    # Load .env file and export all variables
    include .env
    export $(shell sed 's/=.*//' .env | grep -v '^\#')
    
    # Ensure critical environment variables are available
    ifndef WEB3_ALCHEMY_API_KEY
        $(warning WEB3_ALCHEMY_API_KEY not found in .env file)
    endif
else
    $(warning No .env file found, environment variables may be missing)
endif

# Export critical environment variables explicitly
export WEB3_ALCHEMY_API_KEY
export EXPLORER_KEY
export TELEGRAM_VERIF_API_KEY
export TELEGRAM_VERIF_CHAT_ID