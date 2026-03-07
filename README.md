# ClosedLoop.AI Claude Plugins

<div>
  <img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License" />
  <img src="https://img.shields.io/badge/python-3.11+-blue" alt="Python 3.11+" />
  <img src="https://img.shields.io/badge/claude--code-plugin-purple" alt="Claude Code Plugin" />
</div>

<br/>

**Bootstrap. Plan. Code. Ship.** It's that simple.

LLMs are great at non-deterministic content generation — horrible at being repeatably correct.

That's why we took Claude Code and extended it with a lightweight multi-agent orchestration workflow paradigm that works for us; modeling how we collaborate as a team.

Optimized for efficiency & correctness to produce code that lands without the churn; it's grounded in your codebase and outperforms Opus 4.6 out of the box at half the cost.

What's more impactful is that it allowed our team of engineers to shift left; reviewing and approving sprints-worth of work scope in documented implementation plans and generating the code while we slept.

Tickets become Tasks. Epics become Features. Sections of your quarterly roadmap land in a few PRs.

Multi-repository, adaptive self-learning, & artifact-bound phased workflow gates that loop until correct.

**Close the Loop on your SDLC with the same tools that made us 400% faster today.**

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

# Bootstrap.
claude /bootstrap:start

# Plan. Code.
claude /code:start --prd requirements.md
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, workflow, and code style guidelines.

## License

[Apache License 2.0](LICENSE)
