# Security Policy

## Supported versions

Only the latest published version is supported. The extension is tested with OMP 16.5.2 and Node.js 20 or newer.

## Reporting a vulnerability

Please do not report security vulnerabilities in a public issue. Use the repository's GitHub security advisory/private reporting feature: <https://github.com/Baylar55/omp-undo-redo/security/advisories/new>.

Include a concise description, affected version, reproduction steps, impact, and any proposed mitigation. Remove tokens, credentials, private session data, and unrelated personal information before sending a report. If the private channel is unavailable, open a minimal issue asking for a private contact without including vulnerability details.

Maintainers will acknowledge reports when practical, investigate, and coordinate disclosure after a fix or mitigation is available. Please allow reasonable time for triage before public disclosure.

## Scope

The extension navigates OMP's in-memory session tree. It does not promise to roll back files, shell commands, network requests, or other external effects. Reports about those limitations are not security vulnerabilities, but may be filed as normal issues when they describe a reproducible defect.
