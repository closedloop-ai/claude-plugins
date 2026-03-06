# claude-plugins
<img width="832" height="365" alt="image" src="https://github.com/user-attachments/assets/6d5ccbb9-f85d-48a8-ba3f-d42a7a12ead7" />

Open-source Claude Code plugins by ClosedLoop — extending Claude Code with planning, code review, quality judges, and self-learning capabilities.
Why ClosedLoop?
ClosedLoop is an AI platform that brings the speed of individual AI-driven development to the full software development team. We're offering our agents as open sourced Claude Code plugins because we just couldn't keep this a secret for ourselves. Check out our agents for planning, code reviews, judging quality and more that outperform Opus 4.6 and Sonnet 4.5 out of the box.

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

## Benchmarks
<img width="1421" height="862" alt="image" src="https://github.com/user-attachments/assets/82e42af7-9386-4a36-9bc0-2fd5d3564eba" />


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, workflow, and code style guidelines.

## Disclaimer
Our claude code plugins are a low-key engineering preview of the agents that run the larger ClosedLoop platform. These agents should be used for testing in trusted environments.

## License

[Apache License 2.0](LICENSE)
