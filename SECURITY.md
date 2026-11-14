# Security policy

Plinth hosts HTML written by strangers, so security reports matter more here than almost anything
else. Thank you for taking the time.

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a security problem.

- Use GitHub's private vulnerability reporting:
  [Report a vulnerability](https://github.com/mr0b0t0/plinth/security/advisories/new).
- Include the affected version or commit, steps to reproduce, and the impact you see.
- We aim to acknowledge reports within 3 working days and to agree a disclosure date with you.

Test only against your own instance (`npx @mr0b0t0/plinth init` gives you one in a minute). Do not
test against `plinth.aconite.io` in ways that touch other users' data or degrade the service.
Abusive artifacts on the hosted instance go through the **Report** link on the artifact page.

## Supported versions

Fixes go into `main`, which the hosted instance runs, and ship in the next release of the npm CLI
and the Docker image. Only the latest release is supported; upgrade to get fixes.

## What we care about most

The rules in [AGENTS.md](AGENTS.md#security-rules-requirements-not-options) are the security
model: artifact isolation (own subdomain, separate registrable domain, sandboxed frames, CSP on
every response), no app cookies on the content host, one authorization policy checked on every
read and write, and hashed, revocable tokens. [docs/security.md](docs/security.md) explains how
each is enforced. A way around any of them is a vulnerability.
