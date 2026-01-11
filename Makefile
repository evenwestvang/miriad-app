# Cast App - Development Commands

.PHONY: help dev dev-backend dev-frontend build build-backend build-frontend build-container test lint typecheck setup clean

help:
	@echo "Cast App Commands"
	@echo ""
	@echo "Development:"
	@echo "  make dev            Start backend + frontend"
	@echo "  make dev-backend    Start backend only"
	@echo "  make dev-frontend   Start frontend only"
	@echo ""
	@echo "Building:"
	@echo "  make build          Build all"
	@echo "  make build-container Build agent Docker image"
	@echo ""
	@echo "Testing:"
	@echo "  make test           Run tests"
	@echo "  make lint           Lint all"
	@echo "  make typecheck      TypeScript check"
	@echo ""
	@echo "Setup:"
	@echo "  make setup          Initial setup"
	@echo "  make clean          Remove build artifacts"

dev:
	@trap 'kill 0' EXIT; \
		(cd backend && pnpm dev) & \
		(cd frontend && pnpm dev) & \
		wait

dev-backend:
	cd backend && pnpm dev

dev-frontend:
	cd frontend && pnpm dev

build: build-backend build-frontend
	@echo "Build complete"

build-backend:
	cd backend && pnpm install && pnpm build

build-frontend:
	cd frontend && pnpm install && pnpm build

build-container:
	cd agents/sandbox && npm install && npm run build
	docker build --platform linux/arm64 -t cast-agent:local agents/sandbox

test:
	cd backend && pnpm test

lint:
	cd backend && pnpm lint
	cd frontend && pnpm lint

typecheck:
	cd backend && pnpm typecheck

setup:
	@echo "Setting up Cast..."
	@command -v node >/dev/null 2>&1 || { echo "Error: node not found"; exit 1; }
	@command -v pnpm >/dev/null 2>&1 || { echo "Error: pnpm not found"; exit 1; }
	cd backend && pnpm install
	cd frontend && pnpm install
	cd agents/sandbox && npm install
	@if [ ! -f backend/.env ]; then cp backend/.env.example backend/.env; echo "Created backend/.env"; fi
	@echo ""
	@echo "Setup complete! Edit backend/.env then run: make dev"

clean:
	rm -rf backend/packages/*/dist frontend/dist agents/sandbox/dist backend/.aws-sam
