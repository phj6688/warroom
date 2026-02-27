# Contributing to War Room

## Commit Convention

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code change that is neither a fix nor a feature |
| `perf` | Performance improvement |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `chore` | Build, deps, tooling — no production code change |
| `ci` | CI/CD configuration |

### Scopes

`agents` · `phases` · `api` · `ui` · `mcp` · `db` · `docker` · `search` · `export`

### Examples

```
feat(agents): add Ethical Reviewer as 9th council member
fix(api): handle empty escalation answer gracefully
refactor(phases): extract phase runner into separate module
docs(readme): update quick start for Docker Compose v2
chore(deps): bump better-sqlite3 to 11.10.0
```

---

## Branching

```
main              ← stable, tagged releases only
  └── develop     ← integration branch (optional for larger changes)
        ├── feat/<name>
        ├── fix/<name>
        └── chore/<name>
```

- Branch off `main` for hotfixes: `fix/<name>`
- Branch off `main` (or `develop`) for features: `feat/<name>`
- Squash-merge into `main` via PR — keep history clean

---

## Versioning

Follows [Semantic Versioning](https://semver.org/):

- `MAJOR` — breaking API or agent behavior changes
- `MINOR` — new agents, phases, endpoints, backward-compatible
- `PATCH` — bug fixes, performance improvements

Tag format: `v<MAJOR>.<MINOR>.<PATCH>`

Release checklist:
1. Update `version` in `package.json`
2. Add entry to `CHANGELOG.md`
3. Commit: `chore(release): v<version>`
4. Tag: `git tag -a v<version> -m "v<version>"`
5. Push: `git push origin main --tags`

---

## Environment

```bash
cp .env.example .env
npm install
node server.js
```

Tests:

```bash
node --test tests/export.test.mjs
```
