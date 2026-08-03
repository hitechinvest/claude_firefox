#!/usr/bin/env python3
"""Port the "Claude" Chrome extension to Firefox.

The Chrome extension is proprietary Anthropic software and is deliberately not
vendored into this repository.  This script fetches a copy, rewrites the parts
that Firefox cannot execute, and drops in the compatibility layer from
``ff-shim/`` and ``ff-content/``.

    python3 port.py                       # download the current CWS release, build
    python3 port.py --crx claude.crx      # use a local .crx
    python3 port.py --src unpacked/       # use an already unpacked directory
    python3 port.py --xpi                 # also package build/ as a .xpi

See README.md for what does and does not survive the port.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import sys
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent

# The "Claude" extension on the Chrome Web Store.
CHROME_EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn"
CRX_URL = (
    "https://clients2.google.com/service/update2/crx"
    "?response=redirect&prodversion={prodversion}&acceptformat=crx2,crx3"
    "&x=id%3D{ext_id}%26uc"
)

GECKO_ID = "claude-for-firefox@unofficial.port"
# 128 -> content_scripts "world": "MAIN"; 139 -> tabGroups.  The bundle calls
# tabGroups in 60+ places, so 139 is the real floor.
STRICT_MIN_VERSION = "139.0"

# Namespaces Firefox has no implementation for at all.  Keeping them in
# "permissions" makes Firefox reject the manifest, so they are dropped and
# replaced by the shims in ff-shim/.
DROPPED_PERMISSIONS = ("sidePanel", "debugger", "offscreen")

# webRequest backs the Network.* CDP events the debugger shim emits.
ADDED_PERMISSIONS = ("webRequest",)

# Loaded, in order, ahead of the extension's own background entry point.
SHIM_BACKGROUND_SCRIPTS = (
    "ff-shim/00-bootstrap.js",
    "ff-shim/10-runtime.js",
    "ff-shim/20-sidepanel.js",
    "ff-shim/30-offscreen.js",
    "ff-shim/40-debugger.js",
    "ff-shim/50-external.js",
    "ff-shim/60-dnr.js",
)

CLAUDE_MATCHES = ["https://claude.ai/*", "https://*.claude.ai/*"]

# Prepended to the extension's own content scripts so the page-side halves of
# the shims are in place before anything else runs.
SHIM_CONTENT_SCRIPTS = (
    {
        "js": ["ff-content/cdp-main.js"],
        "matches": ["<all_urls>"],
        "run_at": "document_start",
        "all_frames": True,
        "world": "MAIN",
    },
    {
        "js": ["ff-content/cdp-agent.js"],
        "matches": ["<all_urls>"],
        "run_at": "document_start",
        "all_frames": True,
    },
    {
        "js": ["ff-content/claude-bridge-main.js"],
        "matches": CLAUDE_MATCHES,
        "run_at": "document_start",
        "all_frames": True,
        "world": "MAIN",
    },
    {
        "js": ["ff-content/claude-bridge.js"],
        "matches": CLAUDE_MATCHES,
        "run_at": "document_start",
        "all_frames": True,
    },
)

# Substituted into MAIN-world scripts, which cannot reach runtime.getURL().
PLACEHOLDERS = {"__FF_EXTENSION_ID__": GECKO_ID}

# Upstream ships an 800x801 "icon-128.png"; Chrome does not care, Firefox
# rejects non-square icons.  The bundle also carries a square SVG.
SQUARE_SVG_ICON = "claude_icon.svg"


def log(msg: str) -> None:
    print(f"  {msg}")


def step(msg: str) -> None:
    print(f"\n\033[1m{msg}\033[0m")


# --------------------------------------------------------------------------
# acquiring the Chrome extension
# --------------------------------------------------------------------------


def download_crx(ext_id: str, dest: Path, prodversion: str = "130") -> Path:
    url = CRX_URL.format(ext_id=ext_id, prodversion=prodversion)
    log(f"GET {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp, dest.open("wb") as fh:
        shutil.copyfileobj(resp, fh)
    log(f"{dest.name}: {dest.stat().st_size / 1e6:.1f} MB")
    return dest


def crx_to_zip(crx: Path, dest: Path) -> Path:
    """Strip the CRX2/CRX3 header, leaving the embedded ZIP."""
    data = crx.read_bytes()
    if data[:4] != b"Cr24":
        raise SystemExit(f"{crx} is not a CRX archive")
    version = struct.unpack("<I", data[4:8])[0]
    if version == 2:
        pubkey_len, sig_len = struct.unpack("<II", data[8:16])
        offset = 16 + pubkey_len + sig_len
    elif version == 3:
        offset = 12 + struct.unpack("<I", data[8:12])[0]
    else:
        raise SystemExit(f"unsupported CRX version {version}")
    dest.write_bytes(data[offset:])
    return dest


def unpack(zip_path: Path, dest: Path) -> Path:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.infolist():
            # Refuse absolute paths and traversal in the archive.
            target = (dest / member.filename).resolve()
            if not str(target).startswith(str(dest.resolve())):
                raise SystemExit(f"unsafe path in archive: {member.filename}")
            zf.extract(member, dest)
    return dest


# --------------------------------------------------------------------------
# manifest transformation
# --------------------------------------------------------------------------


def png_size(path: Path) -> tuple[int, int] | None:
    """Width and height from a PNG's IHDR chunk, or None if it is not a PNG."""
    try:
        header = path.read_bytes()[:24]
    except OSError:
        return None
    if header[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", header[16:24])


def pick_icon(root: Path, current: str) -> tuple[str, str | None]:
    """Return (icon path, note).  Falls back to the square SVG when needed."""
    size = png_size(root / current)
    if size is None or size[0] == size[1]:
        return current, None
    if not (root / SQUARE_SVG_ICON).is_file():
        return current, (
            f"{current} is {size[0]}x{size[1]} and not square; Firefox will warn"
        )
    return SQUARE_SVG_ICON, (
        f"icons: {current} is {size[0]}x{size[1]}, using {SQUARE_SVG_ICON} instead"
    )


def port_manifest(src: dict, root: Path) -> tuple[dict, list[str]]:
    """Chrome MV3 manifest -> Firefox MV3 manifest.  Returns (manifest, notes)."""
    m = json.loads(json.dumps(src))  # deep copy
    notes: list[str] = []

    # -- icons ----------------------------------------------------------------
    icons = m.get("icons", {})
    icon = next(iter(icons.values()), "icon-128.png")
    icon, icon_note = pick_icon(root, icon)
    if icon_note:
        notes.append(icon_note)
    m["icons"] = {"128": icon}

    # -- Chrome Web Store bookkeeping, meaningless (and rejected) in Firefox ---
    for key in ("update_url", "key", "minimum_chrome_version"):
        if m.pop(key, None) is not None:
            notes.append(f"removed {key}")

    # -- Firefox needs a stable add-on id -------------------------------------
    m["browser_specific_settings"] = {
        "gecko": {
            "id": GECKO_ID,
            "strict_min_version": STRICT_MIN_VERSION,
            # The extension reads page content and tab activity and sends them
            # to Anthropic.  Re-check this list when upstream adds features.
            # "technicalAndInteraction" (telemetry) may only be optional.
            "data_collection_permissions": {
                "required": ["websiteContent", "browsingActivity"],
                "optional": ["technicalAndInteraction"],
            },
        }
    }
    notes.append(f"browser_specific_settings.gecko.id = {GECKO_ID}")

    m["name"] = "Claude (Firefox port)"
    m["description"] = "Unofficial Firefox port of the Claude browser extension"

    # -- background: Firefox has no service worker background -----------------
    m["background"] = {
        "scripts": [*SHIM_BACKGROUND_SCRIPTS, src["background"]["service_worker"]],
        "type": "module",
    }
    notes.append("background.service_worker -> background.scripts (event page)")

    # -- permissions ----------------------------------------------------------
    perms = [p for p in m.get("permissions", []) if p not in DROPPED_PERMISSIONS]
    for p in ADDED_PERMISSIONS:
        if p not in perms:
            perms.append(p)
    m["permissions"] = perms
    notes.append(
        "permissions: dropped "
        + ", ".join(DROPPED_PERMISSIONS)
        + "; added "
        + ", ".join(ADDED_PERMISSIONS)
    )

    # -- side panel -> sidebar ------------------------------------------------
    m["sidebar_action"] = {
        "default_title": "Claude",
        "default_panel": "sidepanel.html",
        "default_icon": {"128": icon},
        "open_at_install": False,
    }
    notes.append("added sidebar_action (chrome.sidePanel is shimmed onto it)")

    # -- externally_connectable has no Firefox equivalent ---------------------
    if m.pop("externally_connectable", None) is not None:
        notes.append("externally_connectable -> postMessage bridge on claude.ai")

    # -- managed storage schema uses a Chrome-only manifest key ---------------
    if isinstance(m.get("storage"), dict) and "managed_schema" in m["storage"]:
        m.pop("storage")
        notes.append("removed storage.managed_schema (Chrome-only manifest key)")

    # -- content scripts ------------------------------------------------------
    m["content_scripts"] = [
        json.loads(json.dumps(cs)) for cs in SHIM_CONTENT_SCRIPTS
    ] + m.get("content_scripts", [])
    notes.append(f"prepended {len(SHIM_CONTENT_SCRIPTS)} shim content scripts")

    # -- web accessible resources --------------------------------------------
    # The shim scripts deliberately stay out of here: declared content scripts
    # and scripting.executeScript read straight from the package, so exposing
    # them to web pages would only widen the attack surface.
    war = m.get("web_accessible_resources", [])
    for entry in war:
        entry.pop("use_dynamic_url", None)  # not supported by Firefox
    m["web_accessible_resources"] = war
    notes.append("removed use_dynamic_url from web_accessible_resources")

    return m, notes


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------


def copy_shims(out: Path) -> None:
    for name in ("ff-shim", "ff-content"):
        src_dir = REPO / name
        if not src_dir.is_dir():
            raise SystemExit(f"missing {src_dir}")
        dst_dir = out / name
        if dst_dir.exists():
            shutil.rmtree(dst_dir)
        shutil.copytree(src_dir, dst_dir)
        for path in sorted(dst_dir.rglob("*.js")):
            text = path.read_text(encoding="utf-8")
            replaced = text
            for placeholder, value in PLACEHOLDERS.items():
                replaced = replaced.replace(placeholder, value)
            if replaced != text:
                path.write_text(replaced, encoding="utf-8")
        log(f"{name}/: {len(list(dst_dir.rglob('*.js')))} files")


def build(source: Path, out: Path) -> dict:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(source, out)

    # Chrome Web Store signing metadata; meaningless in an XPI.
    shutil.rmtree(out / "_metadata", ignore_errors=True)

    manifest_path = out / "manifest.json"
    original = json.loads(manifest_path.read_text(encoding="utf-8"))
    ported, notes = port_manifest(original, out)
    manifest_path.write_text(
        json.dumps(ported, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    for note in notes:
        log(note)

    copy_shims(out)
    return ported


def package(out: Path, xpi_path: Path) -> Path:
    xpi_path.parent.mkdir(parents=True, exist_ok=True)
    if xpi_path.exists():
        xpi_path.unlink()
    with zipfile.ZipFile(xpi_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(out.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(out).as_posix())
    log(f"{xpi_path} ({xpi_path.stat().st_size / 1e6:.1f} MB)")
    return xpi_path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--crx", type=Path, help="use a local .crx instead of downloading")
    src.add_argument("--src", type=Path, help="use an already unpacked directory")
    ap.add_argument("--extension-id", default=CHROME_EXTENSION_ID)
    ap.add_argument("--out", type=Path, default=REPO / "build")
    ap.add_argument("--work", type=Path, default=REPO / ".work")
    ap.add_argument("--xpi", action="store_true", help="also package build/ as a .xpi")
    args = ap.parse_args(argv)

    args.work.mkdir(parents=True, exist_ok=True)

    if args.src:
        step("1/3  Using unpacked source")
        source = args.src
        log(str(source))
    else:
        step("1/3  Fetching the Chrome extension")
        crx = args.crx or download_crx(args.extension_id, args.work / "claude.crx")
        crx_to_zip(crx, args.work / "claude.zip")
        source = unpack(args.work / "claude.zip", args.work / "chrome-src")
        log(f"unpacked to {source}")

    if not (source / "manifest.json").is_file():
        raise SystemExit(f"no manifest.json in {source}")

    step("2/3  Porting to Firefox")
    manifest = build(source, args.out)

    step("3/3  Result")
    log(f"version {manifest['version']} -> {args.out}")
    if args.xpi:
        package(args.out, REPO / "dist" / f"claude-firefox-{manifest['version']}.xpi")

    print(
        "\nLoad it with about:debugging#/runtime/this-firefox -> "
        "Load Temporary Add-on -> build/manifest.json"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
