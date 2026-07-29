---
kind: configuration_system
name: Hermes Studio Configuration System
category: configuration_system
scope:
    - '**'
source_files:
    - data/hermes/config.yaml
    - data/hermes/.env
    - config/experts-marketplace.yaml
    - config/experts-marketplace.yaml.example
---

The Hermes Web UI Monorepo uses a multi-layered configuration system that combines YAML files, environment variables, and build-time constants across different runtime contexts.

## What System/Approach is Used

The configuration system follows a layered approach:
1. **YAML-based configuration** - Primary application settings stored in `data/hermes/config.yaml`
2. **Environment variables** - Secrets and runtime overrides via `.env` files
3. **Build-time configuration** - Vite environment variables (`VITE_HERMES_*`) for client-side builds
4. **Feature-specific YAML configs** - Separate config files for specialized features like the experts marketplace

## Key Files and Packages

- **`data/hermes/config.yaml`** - Main application configuration containing model defaults (default model: MiniMax-M3, provider: minimax-cn) and onboarding state tracking
- **`data/hermes/.env`** - Environment variables for external service credentials (WeChat integration, API keys)
- **`config/experts-marketplace.yaml`** - Experts marketplace configuration with base URL, caching, and package management settings
- **`config/experts-marketplace.yaml.example`** - Template file showing available configuration options including `baseUrl`, `cacheTtlSeconds`, `localPackagesRoot`, `clientIdTemplate`, `maxPackageBytes`, and timeout settings

## Architecture and Conventions

The configuration system follows these patterns:

**Layered Loading Order:**
- Default values are embedded in code or example configs
- User-provided YAML files override defaults
- Environment variables provide runtime overrides
- Build-time constants configure client behavior

**Configuration Organization:**
- Application-level settings in `data/hermes/config.yaml`
- Feature-specific configurations in dedicated YAML files under `config/`
- Secrets and credentials isolated in `.env` files
- Example templates provided as `.yaml.example` files for easy setup

**Runtime Context Separation:**
- Client-side uses Vite's `import.meta.env` for build-time configuration
- Server-side reads from filesystem YAML files and environment variables
- Desktop and Electron environments may have additional platform-specific configuration

## Conventions and Constraints

**File Naming Conventions:**
- Configuration files use `.yaml` extension
- Example/template files use `.yaml.example` suffix
- Environment files use standard `.env` naming
- Configuration files are kept separate from source code in `data/` and `config/` directories

**Security Practices:**
- Credentials stored in `.env` files rather than configuration files
- Example configs show structure without sensitive values
- Comments indicate which fields should not be committed to version control

**Configuration Structure:**
- YAML files use simple key-value structures for most settings
- Nested objects used for complex configurations (like model settings)
- Boolean flags for feature toggles and state tracking
- Numeric values with clear units (bytes, milliseconds, seconds)

**Development Workflow:**
- Local development configs explicitly marked as non-commit files
- Template files provided for easy configuration setup
- Configuration changes can be reloaded without full application restart where supported