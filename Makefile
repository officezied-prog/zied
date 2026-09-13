PY ?= .venv/bin/python
DB ?= postgresql://localhost/smartstylist

FLUTTER ?= flutter

.PHONY: help venv db test api worker worker-vton lint openapi mobile-test mobile-analyze verify clean

help:
	@grep -E '^[a-z-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n",$$1,$$2}'

venv: ## create the virtualenv and install dependencies
	python3 -m venv .venv && $(PY) -m pip install -q -U pip && $(PY) -m pip install -q -r requirements-dev.txt

db: ## apply migrations + seeds and run the SQL smoke test
	./scripts/db_bootstrap.sh "$(DB)"

test: ## run the full python test suite
	$(PY) -m pytest -q

api: ## run the API locally
	$(PY) -m uvicorn api.app.main:app --reload --port 8000

worker: ## run the vision worker
	$(PY) -m workers.vision.runner

worker-vton: ## run the try-on worker
	$(PY) -m workers.vton.runner

worker-once: ## process one vision batch and exit
	$(PY) -m workers.vision.runner --once

demo: ## end-to-end demonstration of all four backend phases
	$(PY) scripts/demo_journey.py

openapi: ## validate the API contract
	$(PY) -c "import yaml;from openapi_spec_validator import validate;validate(yaml.safe_load(open('api/openapi/openapi.yaml')));print('OpenAPI 3.1 valid')"

lint: ## ruff
	$(PY) -m ruff check api workers tests

mobile-analyze: ## flutter analyze
	cd mobile && $(FLUTTER) pub get && $(FLUTTER) analyze

mobile-test: ## flutter test
	cd mobile && $(FLUTTER) test

verify: db test lint openapi mobile-analyze mobile-test ## everything

clean:
	find . -name __pycache__ -type d -prune -exec rm -rf {} + ; rm -rf .pytest_cache
