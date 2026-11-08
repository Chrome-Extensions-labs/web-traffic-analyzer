"""Create GitHub issues and PR comments from AI-generated change analysis.

This module runs inside GitHub Actions and inspects push or pull-request
events. It gathers the relevant diff, sends it to a hosted model with a
role-specific prompt (selected via event labels or diff auto-detection), and
uses the structured JSON response to open a GitHub issue and, for pull
requests, post a summary comment.

The workflow entry-point is ``python scripts/trigger_action.py``; all logic
lives behind :func:`main` so the module is import-safe and unit-testable.

Environment variables:
    GITHUB_TOKEN (required): Token used for all PyGithub API calls.
    GH_MODELS_TOKEN (required): Bearer token for the hosted inference endpoint.
    REPOSITORY (required): ``owner/repo`` identifier to inspect.
    EVENT_NAME (required): ``push`` or ``pull_request``.
    COMMIT_SHA: Commit to inspect for push events (falls back to the PR head).
    PR_NUMBER: Pull request number for pull_request events.
    GITHUB_ACTOR: Actor login, used for the allow-list check on push events.
    ALLOWED_USER: Comma-separated allow-list of GitHub logins. An empty list
        fails closed — nobody is eligible.
"""

import json
import os
import re
import sys
import time
from itertools import islice

import requests
from github import Auth, Github

MODEL_NAME = "Llama-3.3-70B-Instruct"
ENDPOINT = "https://models.inference.ai.azure.com/chat/completions"

MAX_DIFF_PUSH = 10_000
MAX_DIFF_PR = 80_000
MIN_DIFF_LENGTH = 50
# Bound the issue scan so a large tracker cannot exhaust the job timeout.
ISSUE_SCAN_LIMIT = 200
MODEL_RETRIES = 3
MODEL_RETRY_DELAY_SECONDS = 5
MODEL_TIMEOUT_SECONDS = 60


def parse_allowed_users(raw):
    """Parse the comma-separated allow-list, dropping empty entries."""
    return [name.strip().lower() for name in (raw or "").split(",") if name.strip()]


def require_env(name):
    value = os.environ.get(name)
    if not value:
        print(f"Missing required environment variable: {name}")
        sys.exit(1)
    return value


def accumulate_diff(files, max_length):
    """Build the diff payload, skipping binary files without patches."""
    changed_files = []
    diff_text = ""

    for file in files:
        changed_files.append(file.filename)
        patch = getattr(file, "patch", None)
        section = f"File: {file.filename}\nPatch:\n{patch if patch else '[no patch available]'}\n\n"
        diff_text += section
        if len(diff_text) > max_length:
            diff_text += "\n[Diff truncated...]"
            break

    return changed_files, diff_text


def collect_push_event(repo, allowed_users):
    commit_sha = os.environ.get("COMMIT_SHA")
    if not commit_sha:
        print("COMMIT_SHA is not set; skipping push analysis.")
        return None

    actor_login = os.environ.get("GITHUB_ACTOR", "").strip().lower()
    if not actor_login or actor_login not in allowed_users:
        print(f"Action performed by {actor_login or '<unknown>'}, not in allowed list. Skipping.")
        return None

    commit = repo.get_commit(commit_sha)
    pr_match = re.search(r"\(#(\d+)\)", commit.commit.message)
    dedup_key = f"PR #{pr_match.group(1)}" if pr_match else f"commit:{commit_sha[:7]}"

    changed_files, diff_text = accumulate_diff(commit.files, MAX_DIFF_PUSH)

    return {
        "dedup_key": dedup_key,
        "event_context": f"Commit Message: {commit.commit.message}",
        "trigger_labels": [m.lower() for m in re.findall(r"\[(.*?)\]", commit.commit.message)],
        "changed_files": changed_files,
        "diff_text": diff_text,
        "pr_ref": None,
        "commit_sha": commit_sha,
    }


def collect_pull_request_event(repo, allowed_users):
    pr_number = os.environ.get("PR_NUMBER")
    if not pr_number:
        print("PR_NUMBER is not set; skipping pull request analysis.")
        return None

    try:
        pr = repo.get_pull(int(pr_number))
    except ValueError:
        print(f"PR_NUMBER {pr_number!r} is not an integer; skipping.")
        return None

    author_login = (pr.user.login or "").strip().lower()
    if not author_login or author_login not in allowed_users:
        print(f"Pull request opened by {author_login or '<unknown>'}, not in allowed list. Skipping.")
        return None

    changed_files, diff_text = accumulate_diff(pr.get_files(), MAX_DIFF_PR)

    return {
        "dedup_key": f"PR #{pr_number}",
        "event_context": f"PR Title: {pr.title}\nPR Body: {pr.body}",
        "trigger_labels": [label.name.lower() for label in pr.labels],
        "changed_files": changed_files,
        "diff_text": diff_text,
        "pr_ref": pr,
        "commit_sha": pr.head.sha,
    }


def iter_reviewable_issues(repo, state):
    """Yield issues only, skipping the pull requests the API also returns."""
    for issue in islice(repo.get_issues(state=state), ISSUE_SCAN_LIMIT):
        if getattr(issue, "pull_request", None) is not None:
            continue
        yield issue


def find_duplicate_issue(repo, dedup_key):
    for issue in iter_reviewable_issues(repo, "all"):
        if dedup_key in (issue.body or ""):
            print(f"Issue for {dedup_key} already exists (#{issue.number}), skipping.")
            return issue
    return None


def was_already_closed(repo, title_keyword):
    """Return whether a similar issue title already exists in closed issues."""
    keyword = (title_keyword or "").lower()
    if not keyword:
        return False
    for issue in iter_reviewable_issues(repo, "closed"):
        if keyword in (issue.title or "").lower():
            print(f"Similar closed issue found: #{issue.number} — skipping.")
            return True
    return False


def build_permalink(repo_name, commit_sha, filename, line=1):
    return f"https://github.com/{repo_name}/blob/{commit_sha}/{filename}#L{line}"


# Auto-detection of change type from file paths and diff content.
# Used when no explicit labels are provided in commit message or PR.
def detect_change_type(files: list, diff: str, context: str) -> str:
    """Determine the analysis role based on changed file paths and diff content.

    Inspects the list of changed files and diff text to infer what kind of
    review is most appropriate. Returns a role key that maps to a specific
    prompt persona.

    Args:
        files: List of changed file paths.
        diff: The accumulated diff text.
        context: Commit message or PR title/body.

    Returns:
        A string role key: "security", "deps", "ci", "docs", "frontend",
        "backend", "config", or "general".
    """
    files_lower = [f.lower() for f in files]
    diff_lower = diff.lower()

    has_security_keywords = any(kw in diff_lower for kw in [
        "secret", "token", "password", "api_key", "apikey", "auth",
        "credential", "private_key", "access_key", "bearer",
        "vulnerability", "cve-", "injection", "xss", "csrf",
    ])
    has_security_files = any(f for f in files_lower if any(kw in f for kw in [
        "security", "auth", ".env", "secret",
    ]))
    if has_security_keywords or has_security_files:
        return "security"

    has_dep_files = any(f for f in files_lower if any(kw in f for kw in [
        "requirements", "package.json", "package-lock", "pipfile",
        "poetry.lock", "cargo.toml", "go.sum", "gemfile",
        "dependabot", "renovate",
    ]))
    if has_dep_files:
        return "deps"

    has_ci_files = any(f for f in files_lower if any(kw in f for kw in [
        ".github/workflows/", "jenkinsfile", ".gitlab-ci",
        ".circleci", "dockerfile", "docker-compose",
        ".github/actions/",
    ]))
    if has_ci_files:
        return "ci"

    has_doc_files = all(
        any(kw in f for kw in [
            "readme", "contributing", "changelog", "license",
            "docs/", "doc/", ".md", ".rst", ".txt",
        ])
        for f in files_lower
    )
    if has_doc_files and files_lower:
        return "docs"

    has_frontend_files = any(f for f in files_lower if any(kw in f for kw in [
        ".html", ".css", ".jsx", ".tsx", ".vue", ".svelte",
        "frontend/", "public/", "static/", "assets/",
    ]))
    has_frontend_keywords = any(kw in diff_lower for kw in [
        "classname", "style=", "onclick", "addeventlistener",
        "document.get", "innerhtml", "appendchild",
    ])
    if has_frontend_files or has_frontend_keywords:
        return "frontend"

    has_backend_files = any(f for f in files_lower if any(kw in f for kw in [
        ".py", ".go", ".java", ".rb", ".rs", ".php",
        "api/", "server/", "backend/", "lib/", "src/",
    ]))
    if has_backend_files:
        return "backend"

    has_config_files = any(f for f in files_lower if any(kw in f for kw in [
        ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
        ".json", ".env",
    ]))
    if has_config_files:
        return "config"

    return "general"

severity_guide = """
Use the following severity scale. You have 7 levels — pick the one that best matches the ACTUAL impact:

CRITICAL — Production-breaking changes, security vulnerabilities (exposed secrets, SQL injection, XSS, CSRF, broken auth), data loss risks, or changes that could cause service outages.

HIGH — Significant logic changes affecting core functionality, new or modified API endpoints, permission and access control modifications, database schema changes, removal of important functionality, breaking changes to public interfaces.

ELEVATED — New substantial features or modules, large-scale refactors that change behavior across multiple files, integration with external services or APIs, changes to error handling or retry logic, modifications to data processing pipelines.

MEDIUM — New utility functions or helpers, workflow and CI/CD pipeline changes, configuration changes that affect runtime behavior, dependency version updates, adding new files with meaningful functionality, structural reorganization of existing code.

MODERATE — Minor feature additions, small behavioral changes, adding validation or input checks, improving logging or error messages, updating environment variables or build settings, adding new labels or issue templates.

LOW — Documentation updates (README, CONTRIBUTING, comments), cosmetic UI changes without behavior impact, code formatting or style fixes, renaming without behavior change, adding badges or metadata, updating .gitignore or editor configs.

INFORMATIONAL — Trivial changes: fixing typos, whitespace adjustments, comment rewording, version bumps in non-critical files, adding blank lines.

IMPORTANT: Do NOT default to LOW or INFORMATIONAL. Carefully evaluate the actual scope and impact. Most code changes that add or modify functionality should be MEDIUM or higher. Use the full range of the scale.
"""

# ---------------------------------------------------------------------------
# Structured output contract sent to the model.
# ---------------------------------------------------------------------------
base_instructions = """
Return only a raw JSON object with no markdown formatting. The JSON must have these exact keys:

"issue_title": string — include severity prefix like [CRITICAL], [HIGH], [ELEVATED], [MEDIUM], [MODERATE], [LOW], or [INFO] at the start,
"severity": string — one of: critical, high, elevated, medium, moderate, low, informational,
"issue_body": string — must include these sections:
  ## Problem
  (clear description with exact file paths and line numbers if known)

  ## Code Reference
  (the exact problematic code snippet or the key changed code)

  ## Suggested Fix
  (concrete code or steps to fix — or "No action required" for informational changes)

  ## Permalink
  (placeholder: PUT_PERMALINK_HERE — will be replaced automatically)

"labels": list of strings — standard GitHub labels plus the severity level,
"affected_file": string — the most relevant filename from the diff (or "" if unknown),
"affected_line": integer — approximate line number of the issue (or 1 if unknown),
"summary": string — 2-3 sentence plain-English summary for the PR comment

The issue_title, issue_body and summary MUST be written entirely in English.
"""

# ---------------------------------------------------------------------------
# Prompt role definitions — keyed by label match or auto-detected type.
# ---------------------------------------------------------------------------
PROMPT_ROLES = {
    "security": (
        "Act as a Strict Security Auditor. Perform a deep security audit "
        "(OWASP Top 10, CWE patterns). Find real vulnerabilities with exact "
        "file/line references. Check for exposed secrets, injection vectors, "
        "broken auth, insecure deserialization, and misconfigurations."
    ),
    "review": (
        "Act as a Strict Code Reviewer. Analyze code quality using SOLID, DRY, "
        "and KISS principles. Point to exact lines that violate these principles. "
        "Evaluate naming, error handling, and separation of concerns."
    ),
    "qa": (
        "Act as a QA Engineer. Identify edge cases, missing test coverage, "
        "untested error paths, and potential regressions. Reference exact "
        "functions and lines that need tests."
    ),
    "perf": (
        "Act as a Performance Expert. Analyze algorithmic complexity, identify "
        "O(n²) patterns, unnecessary allocations, N+1 queries, blocking I/O, "
        "and missed caching opportunities. Reference exact lines."
    ),
    "pm": (
        "Act as a Product Manager. Generate user-facing Release Notes with "
        "clear impact descriptions. Focus on what changed for the end user, "
        "not implementation details."
    ),
    "deps": (
        "Act as a Security & Dependency Auditor. Analyze all new or changed "
        "dependencies: check for known vulnerabilities (CVEs), license "
        "compatibility (MIT/Apache/GPL), package size impact, maintenance "
        "status, and whether each dep is actively maintained. Reference exact "
        "file and line where each dependency is added or changed."
    ),
    "arch": (
        "Act as a Software Architect. Review changes for architectural issues: "
        "violation of separation of concerns, tight coupling, wrong layer "
        "dependencies, anti-patterns (God object, spaghetti logic, magic "
        "numbers, circular dependencies). Reference exact files and lines."
    ),
    "ci": (
        "Act as a DevOps/CI Engineer. Review the CI/CD pipeline changes for "
        "correctness, security (token permissions, secret exposure), efficiency "
        "(caching, parallelism, job dependencies), and best practices. Check "
        "for overly broad permissions, missing timeout limits, and potential "
        "race conditions in workflows."
    ),
    "docs": (
        "Act as a Technical Writer. Review the documentation changes for "
        "completeness, accuracy, clarity, and consistency. Check that code "
        "examples are correct, links are valid, and the structure is logical. "
        "Note any missing sections or outdated information."
    ),
    "frontend": (
        "Act as a Frontend Engineer. Review the UI/UX changes for accessibility "
        "(a11y), responsive design, performance (bundle size, render blocking), "
        "XSS risks in DOM manipulation, proper event handling, and browser "
        "compatibility. Reference exact files and lines."
    ),
    "backend": (
        "Act as a Senior Backend Engineer. Review the changes for correctness, "
        "error handling, input validation, resource management (file handles, "
        "connections), concurrency safety, and API contract compliance. "
        "Reference exact files and lines."
    ),
    "config": (
        "Act as a Configuration & Infrastructure Reviewer. Analyze the config "
        "changes for correctness, security implications (exposed ports, "
        "permissive CORS, debug mode in production), consistency across "
        "environments, and potential breaking changes for existing deployments."
    ),
    "general": (
        "Act as a Senior Software Engineer reviewing a colleague's changes. "
        "Provide a thorough assessment covering: what was changed and why, "
        "whether the changes introduce any risks or bugs, code quality, "
        "and the overall scope and impact on the project."
    ),
}

# Maps commit-message bracket labels and PR labels to role keys.
LABEL_TO_ROLE = {
    "sec": "security", "security": "security", "audit": "security",
    "review": "review", "refactor": "review", "code-review": "review",
    "qa": "qa", "test": "qa", "testing": "qa",
    "perf": "perf", "performance": "perf", "optimize": "perf",
    "pm": "pm", "release": "pm", "product": "pm",
    "deps": "deps", "dependencies": "deps", "dep": "deps",
    "arch": "arch", "architecture": "arch",
    "ci": "ci", "devops": "ci", "pipeline": "ci", "workflow": "ci",
    "docs": "docs", "doc": "docs", "documentation": "docs",
    "frontend": "frontend", "ui": "frontend", "ux": "frontend", "css": "frontend",
    "backend": "backend", "api": "backend", "server": "backend",
    "config": "config", "infra": "config", "infrastructure": "config",
}


# Prompt routing — label match first, then auto-detection from diff content.
def select_role_key(trigger_labels, changed_files, diff_text, event_context):
    for label in trigger_labels:
        if label in LABEL_TO_ROLE:
            return LABEL_TO_ROLE[label]
    role = detect_change_type(changed_files, diff_text, event_context)
    print(f"Auto-detected change type: {role}")
    return role


def build_prompt(role_key, event_context, changed_files, diff_text):
    role_instruction = PROMPT_ROLES.get(role_key, PROMPT_ROLES["general"])
    return f"""{role_instruction}

Do NOT invent problems that do not exist in the diff. Base your analysis strictly on what you see.
{severity_guide}
Context: {event_context}
Changed files: {", ".join(changed_files)}
Changes: {diff_text}
{base_instructions}"""


def call_model(model_token, prompt):
    """Send a review prompt to the hosted model and parse the JSON reply."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {model_token}",
    }
    payload = {
        "messages": [
            {"role": "system", "content": "You are a professional software auditor. Always return valid JSON only. No markdown, no explanation, just the JSON object."},
            {"role": "user", "content": prompt},
        ],
        "model": MODEL_NAME,
        "temperature": 0.1,
    }

    for attempt in range(1, MODEL_RETRIES + 1):
        try:
            resp = requests.post(ENDPOINT, headers=headers, json=payload, timeout=MODEL_TIMEOUT_SECONDS)
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"]["content"].strip()
            raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()
            return json.loads(raw)
        except Exception as error:
            print(f"Attempt {attempt} failed: {error}")
            if attempt < MODEL_RETRIES:
                time.sleep(MODEL_RETRY_DELAY_SECONDS)

    print("All attempts failed. Exiting gracefully.")
    sys.exit(0)


SEVERITY_LABELS = {
    "critical": "severity: critical",
    "high": "severity: high",
    "elevated": "severity: elevated",
    "medium": "severity: medium",
    "moderate": "severity: moderate",
    "low": "severity: low",
    "informational": "severity: informational",
}


def main():
    gh_token = require_env("GITHUB_TOKEN")
    model_token = require_env("GH_MODELS_TOKEN")
    repo_name = require_env("REPOSITORY")
    event_name = os.environ.get("EVENT_NAME", "").strip().lower()

    allowed_users = parse_allowed_users(os.environ.get("ALLOWED_USER"))
    if not allowed_users:
        # Fail closed: without an explicit allow-list, nobody is eligible.
        print("ALLOWED_USER is empty; nobody is eligible for analysis. Skipping.")
        return 0

    gh = Github(auth=Auth.Token(gh_token))
    repo = gh.get_repo(repo_name)

    if event_name == "push":
        context = collect_push_event(repo, allowed_users)
    elif event_name == "pull_request":
        context = collect_pull_request_event(repo, allowed_users)
    else:
        print(f"Unsupported event: {event_name or '<unset>'}. Skipping.")
        return 0

    if context is None:
        return 0

    if len(context["diff_text"].strip()) < MIN_DIFF_LENGTH:
        print("Diff too small to analyze. Skipping.")
        return 0

    if find_duplicate_issue(repo, context["dedup_key"]) is not None:
        return 0

    role_key = select_role_key(
        context["trigger_labels"],
        context["changed_files"],
        context["diff_text"],
        context["event_context"],
    )
    prompt = build_prompt(role_key, context["event_context"], context["changed_files"], context["diff_text"])

    result = call_model(model_token, prompt)
    if not isinstance(result, dict):
        print("Model returned a non-object JSON payload. Exiting gracefully.")
        return 0

    issue_title = str(result.get("issue_title") or "").strip()
    issue_body = str(result.get("issue_body") or "").strip()
    if not issue_title or not issue_body:
        print("Model response is missing issue_title or issue_body. Exiting gracefully.")
        return 0

    title_keyword = issue_title[:40]
    if was_already_closed(repo, title_keyword):
        return 0

    affected_file = str(result.get("affected_file") or "")
    try:
        affected_line = int(result.get("affected_line") or 1)
    except (TypeError, ValueError):
        affected_line = 1

    if affected_file:
        permalink = build_permalink(repo_name, context["commit_sha"], affected_file, affected_line)
        issue_body = issue_body.replace("PUT_PERMALINK_HERE", permalink)
    else:
        issue_body = issue_body.replace("PUT_PERMALINK_HERE", "_No specific file identified_")

    actor_name = os.environ.get("GITHUB_ACTOR", "unknown")
    footer = (
        f"\n\n---\n*Generated from {context['dedup_key']} | "
        f"Auto-detected role: `{role_key}` | Processed by actor: {actor_name}*"
    )

    severity = str(result.get("severity", "medium")).lower()
    severity_label = SEVERITY_LABELS.get(severity, "severity: medium")
    model_labels = result.get("labels") if isinstance(result.get("labels"), list) else []
    all_labels = sorted({str(label) for label in model_labels} | {severity_label})

    issue = repo.create_issue(title=issue_title, body=issue_body + footer, labels=all_labels)
    print(f"Created issue #{issue.number}: {issue.title}")

    pr_ref = context["pr_ref"]
    summary = str(result.get("summary") or "")
    if pr_ref is not None and summary:
        pr_comment = (
            f"### AI Analysis Summary\n\n"
            f"{summary}\n\n"
            f"**Severity:** `{severity.upper()}` | **Role:** `{role_key}`\n\n"
            f"Full details: #{issue.number}"
        )
        pr_ref.create_issue_comment(pr_comment)
        print(f"Posted summary comment to PR #{pr_ref.number}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
