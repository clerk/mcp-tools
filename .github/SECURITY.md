# Security Policy

## Reporting Security Vulnerabilities

We take the security of our software products and services seriously, which includes all source code repositories managed through our GitHub organization.

### How to Report a Security Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you believe you have found a security vulnerability in this project, please report it to us as described below.

**Please report (suspected) security vulnerabilities to:**
📧 **security@clerk.com**

You will receive a response from us as quickly as we are able to provide one, typically within 48 hours. If the issue is confirmed, we will release a patch as soon as possible depending on complexity but historically within a few days.

### What to Include in Your Report

Please include the requested information listed below (as much as you can provide) to help us better understand the nature and scope of the possible issue:

- **Type of issue** (e.g. buffer overflow, SQL injection, cross-site scripting, etc.)
- **Full paths of source file(s) related to the manifestation of the issue**
- **The location of the affected source code** (tag/branch/commit or direct URL)
- **Any special configuration required to reproduce the issue**
- **Step-by-step instructions to reproduce the issue**
- **Proof-of-concept or exploit code** (if possible)
- **Impact of the issue**, including how an attacker might exploit the issue

This information will help us triage your report more quickly.

## Supported Versions

We release patches for security vulnerabilities. Which versions are eligible for receiving such patches depends on the CVSS v3.0 Rating:

| CVSS v3.0 | Supported Versions                        |
| --------- | ----------------------------------------- |
| 9.0-10.0  | Releases within the previous three months |
| 4.0-8.9   | Most recent release                       |

## Our Commitment

### What You Can Expect From Us

When you report a security issue, we commit to:

1. **Acknowledge your report** as quickly as possible
2. **Confirm the problem** and determine the affected versions
3. **Audit code** to find any potential similar problems
4. **Prepare fixes** for all releases still under support
5. **Release new versions** as soon as possible
6. **Publicly disclose the issue** in a responsible manner

### Responsible Disclosure

We kindly ask you to:

- **Give us reasonable time** to investigate and mitigate an issue you report before making any information public
- **Make a good faith effort** to avoid privacy violations, destruction of data, and interruption or degradation of our services
- **Contact us first** before engaging in any security testing of our systems

## Security Best Practices

When contributing to this project, please follow these security guidelines:

- **Dependencies**: Keep dependencies up to date and review dependency alerts
- **Secrets**: Never commit secrets, API keys, or credentials to the repository
- **Code Review**: All code changes require review before merging
- **Authentication**: Use strong authentication methods and enable 2FA
- **Permissions**: Follow the principle of least privilege for access control

## Security Features

This project implements several security measures:

- **Dependency scanning** via Dependabot
- **Secret scanning** to prevent credential leaks
- **Code scanning** with CodeQL for vulnerability detection
- **Branch protection** rules requiring reviews and status checks
- **Signed commits** for verification of code authenticity

## Bug Bounty Program

At this time, we do not have a formal bug bounty program. However, we deeply appreciate security researchers who responsibly disclose vulnerabilities to us, and will issue rewards conditionally.

## Security Updates

Security updates will be announced:

- In the project's release notes
- Via GitHub Security Advisories
- On our security mailing list (if applicable)

To stay informed about security updates, we recommend:

- Watching this repository for releases
- Enabling GitHub notifications for security advisories
- Following [@ClerkDev](https://twitter.com/ClerkDev) on Twitter

## Questions?

If you have questions about this security policy, please contact us at **security@clerk.com**.

## Attribution

This security policy is based on best practices from the open source community and is inspired by security policies from projects like [Electron](https://github.com/electron/electron/blob/main/SECURITY.md), [Django](https://github.com/django/django/blob/main/SECURITY.md), and the [Contributor Covenant](https://www.contributor-covenant.org/).
