# Security Policy

## Supported versions

Security fixes land on the latest release line of each component. Older majors receive fixes at maintainer discretion.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Use GitHub's private vulnerability reporting on this repository, or email the maintainers listed in [MAINTAINERS](MAINTAINERS) with:

- Affected component and version
- Reproduction steps or proof-of-concept
- Impact assessment (confidentiality / integrity / availability)

We aim to acknowledge within **3 business days** and to provide a remediation timeline after triage. Coordinated disclosure is preferred; we will credit reporters who want attribution unless they ask otherwise.

## Scope

In scope: the Open Profiling Agent collector, dashboard, language agents/SDKs, and published container images for those components.

Out of scope: third-party dependencies' unpatched CVEs where no OPA-specific exploit path exists (please report upstream); social engineering; denial-of-service against shared demo environments.
