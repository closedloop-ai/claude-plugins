# claude-plugins

Open-source Claude Code plugins by [ClosedLoop](https://closedloop.ai) — extending Claude Code with planning, code review, quality judges, and self-learning capabilities.

## Plugins

| Plugin | Description |
|--------|-------------|
| **bootstrap** | Project bootstrapping and initial setup |
| **code** | Code generation, implementation planning, and iterative development loop |
| **code-review** | Automated code review with inline GitHub PR comments |
| **judges** | LLM-as-judge evaluators for plan and code quality |
| **platform** | Claude Code expert guidance, prompt engineering, and artifact management |
| **self-learning** | Pattern capture and organizational knowledge sharing |

## Prerequisites

- Python 3.11+ (3.13 recommended)
- [jq](https://jqlang.github.io/jq/)
- [Claude Code](https://claude.ai/code)

## Quick Start

```bash
# Install a plugin from the marketplace
claude /plugin marketplace install closedloop

# Or install from source for development
git clone git@github.com:closedloop-ai/claude-plugins.git
cd claude-plugins
git config core.hooksPath .githooks
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, workflow, and code style guidelines.

## License

[Apache License 2.0](LICENSE)
