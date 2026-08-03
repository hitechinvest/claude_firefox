#!/usr/bin/env python3
"""Static checks over a build produced by port.py.

Two jobs:

1. Catch anything Firefox would reject outright — Chrome-only manifest keys and
   permissions, a service-worker background, missing files.
2. Watch for upstream drift.  The Chrome extension is minified third-party code
   that ships often; when it starts calling a Chrome API the port does not
   cover, this is what notices.

    python3 tools/verify.py [build]

Exit status is non-zero if anything failed.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

FORBIDDEN_MANIFEST_KEYS = (
    "key",
    "update_url",
    "minimum_chrome_version",
    "externally_connectable",
    "side_panel",
)
FORBIDDEN_PERMISSIONS = ("sidePanel", "debugger", "offscreen")

REQUIRED_SHIM_FILES = (
    "ff-shim/00-bootstrap.js",
    "ff-shim/10-runtime.js",
    "ff-shim/20-sidepanel.js",
    "ff-shim/30-offscreen.js",
    "ff-shim/40-debugger.js",
    "ff-shim/50-external.js",
    "ff-shim/60-dnr.js",
    "ff-shim/70-proxy-host.js",
    "ff-shim/80-cors.js",
    "ff-shim/90-netdiag.js",
    "ff-content/cdp-agent.js",
    "ff-content/cdp-main.js",
    "ff-content/claude-bridge.js",
    "ff-content/claude-bridge-main.js",
    "ff-page/sidepanel-entry.html",
    "ff-page/sidepanel-entry.js",
    "ff-page/panel-diagnostics.js",
    "ff-page/page-shims.js",
    "ff-page/proxy-client.js",
)

# Pages that run the extension bundle must load the page-side shims, or the
# bundle hits an undefined chrome.debugger and never renders.
PAGES_NEEDING_SHIMS = ("sidepanel.html", "options.html")
PAGE_SHIM_SRC = "/ff-page/page-shims.js"

# chrome.<namespace> occurrences the port has an answer for.  Anything else on
# Firefox's unsupported list is a finding.
SHIMMED_NAMESPACES = {"debugger", "sidePanel", "offscreen"}

# Namespaces Firefox has no implementation for, as of the versions this port
# targets.  Sources: MDN browser-compat-data.
UNSUPPORTED_NAMESPACES = {
    "debugger",
    "sidePanel",
    "offscreen",
    "declarativeContent",
    "desktopCapture",
    "documentScan",
    "enterprise",
    "fileSystemProvider",
    "gcm",
    "instanceID",
    "loginState",
    "platformKeys",
    "printing",
    "printerProvider",
    "readingList",
    "signedInDevices",
    "system",
    "ttsEngine",
    "vpnProvider",
    "wallpaper",
    "webAuthenticationProxy",
}

NAMESPACE_RE = re.compile(r"\bchrome\.([A-Za-z][A-Za-z0-9_]*)")

problems: list[str] = []
notes: list[str] = []


def fail(message: str) -> None:
    problems.append(message)


def note(message: str) -> None:
    notes.append(message)


def check_manifest(build: Path) -> dict:
    path = build / "manifest.json"
    if not path.is_file():
        fail(f"{path} does not exist — run port.py first")
        return {}

    manifest = json.loads(path.read_text(encoding="utf-8"))

    for key in FORBIDDEN_MANIFEST_KEYS:
        if key in manifest:
            fail(f"manifest still has the Chrome-only key '{key}'")

    if isinstance(manifest.get("storage"), dict) and "managed_schema" in manifest["storage"]:
        fail("manifest still has storage.managed_schema (Chrome-only)")

    for permission in manifest.get("permissions", []):
        if permission in FORBIDDEN_PERMISSIONS:
            fail(f"manifest still requests the unsupported permission '{permission}'")

    background = manifest.get("background", {})
    if "service_worker" in background:
        fail("background.service_worker is not supported by Firefox")
    if not background.get("scripts"):
        fail("background.scripts is missing")

    gecko = manifest.get("browser_specific_settings", {}).get("gecko", {})
    if not gecko.get("id"):
        fail("browser_specific_settings.gecko.id is required by Firefox")
    else:
        note(f"add-on id: {gecko['id']} (min Firefox {gecko.get('strict_min_version', '?')})")

    for entry in manifest.get("web_accessible_resources", []):
        if "use_dynamic_url" in entry:
            fail("web_accessible_resources.use_dynamic_url is not supported by Firefox")

    return manifest


def check_referenced_files(build: Path, manifest: dict) -> None:
    referenced: list[str] = []
    referenced.extend(manifest.get("background", {}).get("scripts", []))
    for entry in manifest.get("content_scripts", []):
        referenced.extend(entry.get("js", []))
        referenced.extend(entry.get("css", []))
    referenced.extend(manifest.get("icons", {}).values())
    if manifest.get("options_page"):
        referenced.append(manifest["options_page"])

    sidebar = manifest.get("sidebar_action", {})
    if sidebar.get("default_panel"):
        referenced.append(sidebar["default_panel"])
    referenced.extend(sidebar.get("default_icon", {}).values())

    missing = [ref for ref in referenced if not (build / ref).is_file()]
    for ref in missing:
        fail(f"manifest references a file that is not in the build: {ref}")

    # web_accessible_resources entries may be globs.
    for entry in manifest.get("web_accessible_resources", []):
        for resource in entry.get("resources", []):
            if not list(build.glob(resource)):
                fail(f"web_accessible_resources matches nothing: {resource}")

    note(f"{len(referenced)} manifest-referenced files, all present")


def check_shims_present(build: Path) -> None:
    for relative in REQUIRED_SHIM_FILES:
        if not (build / relative).is_file():
            fail(f"missing shim: {relative}")
    for relative in REQUIRED_SHIM_FILES:
        path = build / relative
        if not path.is_file() or path.suffix != ".js":
            continue
        if "__FF_EXTENSION_ID__" in path.read_text(encoding="utf-8"):
            fail(f"{relative} still contains the unsubstituted __FF_EXTENSION_ID__ placeholder")


def check_page_shims(build: Path) -> None:
    """Every page that loads the bundle must pull in the page-side shims first."""
    for name in PAGES_NEEDING_SHIMS:
        path = build / name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        if PAGE_SHIM_SRC not in text:
            fail(f"{name} loads the bundle without {PAGE_SHIM_SRC}")
            continue
        if text.index(PAGE_SHIM_SRC) > text.index("/assets/"):
            fail(f"{name} loads the bundle before {PAGE_SHIM_SRC}")
    note(f"page shims present in {', '.join(PAGES_NEEDING_SHIMS)}")


def check_api_drift(build: Path) -> None:
    """Report Chrome APIs used by the bundle that Firefox does not implement."""
    used: dict[str, int] = {}
    for path in build.rglob("*.js"):
        if path.relative_to(build).parts[0] in {"ff-shim", "ff-content", "ff-page"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for namespace in NAMESPACE_RE.findall(text):
            used[namespace] = used.get(namespace, 0) + 1

    unsupported = {ns: n for ns, n in used.items() if ns in UNSUPPORTED_NAMESPACES}
    covered = {ns: n for ns, n in unsupported.items() if ns in SHIMMED_NAMESPACES}
    uncovered = {ns: n for ns, n in unsupported.items() if ns not in SHIMMED_NAMESPACES}

    for namespace, count in sorted(covered.items()):
        note(f"chrome.{namespace}: {count} uses, shimmed")
    for namespace, count in sorted(uncovered.items()):
        fail(
            f"chrome.{namespace}: {count} uses, unsupported by Firefox and not shimmed "
            f"— upstream started using a new API"
        )


def main(argv: list[str]) -> int:
    build = Path(argv[1]) if len(argv) > 1 else REPO / "build"
    print(f"verifying {build}\n")

    manifest = check_manifest(build)
    if manifest:
        check_referenced_files(build, manifest)
        check_shims_present(build)
        check_page_shims(build)
        check_api_drift(build)

    for message in notes:
        print(f"  note  {message}")
    for message in problems:
        print(f"  FAIL  {message}")

    print()
    if problems:
        print(f"{len(problems)} problem(s)")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
