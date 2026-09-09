#!/usr/bin/env python3
"""Verify a bundle's structural integrity.

Checks that all expected files, directories, DLLs, extensions, settings,
and git stubs are present and correct.

Usage:
    python tests/verify_bundle.py <bundle_root> [--platform windows] [--waterproof]

Pass --waterproof for bundles built with bundle.py's --waterproof mode: they
ship the Waterproof extension instead of the (mutually exclusive) lean4 one,
and carry extra settings that wire Lean files to Waterproof's custom editor.
"""

import json
import sys
from pathlib import Path


def _verify_waterproof_editor(ext_name: str, pkg: dict) -> list[str]:
    """Check Waterproof's custom editor is registered at default priority.

    assemble.setup_vscodium_portable rewrites the extension's package.json to
    raise this contribution from "option" to "default": on a fresh profile the
    first file opened from the command line is resolved before
    workbench.editorAssociations reliably takes effect, so without the bump a
    Lean file can open in the plain text editor instead of Waterproof's.
    """
    editors = pkg.get("contributes", {}).get("customEditors", [])
    for editor in editors:
        if editor.get("viewType") != "waterproofTue.waterproofEditor":
            continue
        if editor.get("priority") != "default":
            return [
                f"{ext_name}/package.json: customEditor "
                f"'waterproofTue.waterproofEditor' has priority "
                f"{editor.get('priority')!r}, expected 'default'"
            ]
        return []
    return [
        f"{ext_name}/package.json: no customEditor contribution with "
        "viewType 'waterproofTue.waterproofEditor'"
    ]


def verify(
    bundle_root: Path, platform: str = "windows", waterproof: bool = False
) -> list[str]:
    """Verify bundle structure. Returns list of error strings (empty = OK).

    *waterproof* selects the expected editor frontend: the Waterproof
    extension rather than lean4.
    """
    errors: list[str] = []
    is_windows = platform.startswith("windows")

    lean_exe = "lean.exe" if is_windows else "lean"
    lake_exe = "lake.exe" if is_windows else "lake"
    if is_windows:
        vscodium_exe = "VSCodium.exe"
    elif platform.startswith("darwin"):
        vscodium_exe = "VSCodium.app/Contents/MacOS/VSCodium"
    else:
        vscodium_exe = "bin/codium"
    if is_windows:
        launcher = "Start_Lean.cmd"
    elif platform.startswith("darwin"):
        launcher = "Start_Lean.command"
    else:
        launcher = "Start_Lean.sh"

    # --- Required files and directories ---
    required_files = [
        f"lean/bin/{lean_exe}",
        f"lean/bin/{lake_exe}",
        f"project/lean-toolchain",
        f"project/lake-manifest.json",
        launcher,
    ]
    required_dirs = [
        "lean/lib/lean/Init",
        "lean/lib/lean/Lean",
        "project/.lake/packages",
    ]

    for r in required_files:
        if not (bundle_root / r).is_file():
            errors.append(f"Missing file: {r}")
    for r in required_dirs:
        if not (bundle_root / r).is_dir():
            errors.append(f"Missing directory: {r}")

    # --- Launcher must strip elan from PATH ---
    # If a student has elan from a previous Lean course, the lean4 VS
    # Code extension will find it, query it about our toolchain, and
    # (when the student doesn't have our version installed) pop a modal
    # "Lean version ... is not installed" dialog.  The launcher must
    # scrub elan-containing PATH entries before launching VSCodium so
    # the extension uses the bundled lean directly.
    launcher_path = bundle_root / launcher
    if launcher_path.is_file():
        text = launcher_path.read_text(errors="ignore")
        if "elan" not in text.lower():
            errors.append(
                f"{launcher}: expected elan-stripping logic "
                "(students with prior elan installs will hit the "
                '"Lean version not installed" prompt otherwise)'
            )

    # --- VSCodium ---
    vscodium_path = bundle_root / "vscodium" / vscodium_exe
    if not vscodium_path.is_file():
        errors.append(f"Missing: vscodium/{vscodium_exe}")

    # Extensions — validate both the directory AND the registry.
    # VSCodium portable mode uses extensions.json to discover installed
    # extensions; the directory alone is not enough.
    #
    # The two Lean frontends are mutually exclusive — assemble.py's
    # setup_vscodium_portable refuses to install both — so check that the
    # expected one is present and the other is absent.
    if waterproof:
        ext_id, ext_label = "waterproof-tue.waterproof", "Waterproof"
        other_id, other_label = "leanprover.lean4", "lean4"
    else:
        ext_id, ext_label = "leanprover.lean4", "lean4"
        other_id, other_label = "waterproof-tue.waterproof", "Waterproof"

    ext_parent = bundle_root / "vscodium" / "data" / "extensions"
    if ext_parent.is_dir():
        # Open VSX installs land in "<id>-<version>"; a --waterproof-vsix
        # build lands in "<id>-local".
        ext_dirs = list(ext_parent.glob(f"{ext_id}-*"))
        other_dirs = list(ext_parent.glob(f"{other_id}-*"))
        if other_dirs and ext_dirs:
            errors.append(
                f"Both {ext_label} and {other_label} are installed in "
                "vscodium/data/extensions/; they are mutually exclusive"
            )
        elif other_dirs:
            flag = "without --waterproof" if waterproof else "with --waterproof"
            errors.append(
                f"Found the {other_label} extension where {ext_label} was "
                f"expected — this looks like a {other_label} bundle; re-run "
                f"{flag}"
            )
        if not ext_dirs:
            errors.append(
                f"Missing {ext_label} extension in vscodium/data/extensions/"
            )
        else:
            ext_dir = ext_dirs[0]
            # Extension must have package.json with a main entry point
            ext_pkg = ext_dir / "package.json"
            if not ext_pkg.is_file():
                errors.append(f"Missing package.json in {ext_dir.name}")
            else:
                try:
                    pkg = json.loads(ext_pkg.read_text())
                    main = pkg.get("main", "")
                    if not main:
                        errors.append(f"{ext_dir.name}/package.json: missing 'main' field")
                    else:
                        # Resolve the main entry (e.g. "./dist/extension" -> dist/extension.js)
                        main_path = main.lstrip("./")
                        candidates = [ext_dir / main_path, ext_dir / f"{main_path}.js"]
                        if not any(c.is_file() for c in candidates):
                            errors.append(
                                f"{ext_dir.name}: main entry point '{main}' not found "
                                f"(checked {', '.join(str(c.relative_to(ext_dir)) for c in candidates)})"
                            )
                    if waterproof:
                        errors.extend(_verify_waterproof_editor(ext_dir.name, pkg))
                except json.JSONDecodeError as e:
                    errors.append(f"{ext_dir.name}/package.json: invalid JSON: {e}")

        # Validate extensions.json registry
        registry_path = ext_parent / "extensions.json"
        if not registry_path.is_file():
            errors.append("Missing extensions.json registry in vscodium/data/extensions/")
        else:
            try:
                registry = json.loads(registry_path.read_text())
                if not isinstance(registry, list):
                    errors.append("extensions.json: expected a JSON array")
                else:
                    entries = [
                        e for e in registry
                        if e.get("identifier", {}).get("id") == ext_id
                    ]
                    if not entries:
                        errors.append(
                            f"extensions.json: no entry with identifier '{ext_id}' — "
                            "VSCodium will not load the extension even though files are on disk"
                        )
                    else:
                        entry = entries[0]
                        rel = entry.get("relativeLocation", "")
                        if rel and not (ext_parent / rel).is_dir():
                            errors.append(
                                f"extensions.json: relativeLocation '{rel}' does not exist "
                                f"in vscodium/data/extensions/"
                            )
            except json.JSONDecodeError as e:
                errors.append(f"extensions.json: invalid JSON: {e}")
    else:
        errors.append("Missing directory: vscodium/data/extensions/")

    # Settings
    settings_path = bundle_root / "vscodium" / "data" / "user-data" / "User" / "settings.json"
    if settings_path.is_file():
        try:
            settings = json.loads(settings_path.read_text())
            expected_keys = {
                "update.mode": "none",
                "extensions.autoUpdate": False,
                "telemetry.telemetryLevel": "off",
                "lean4.automaticallyBuildDependencies": False,
                "security.workspace.trust.enabled": False,
            }
            if waterproof:
                # Theme selection is user-scoped: window.autoDetectColorScheme
                # is application-scoped and ignored at workspace scope, so
                # these must land here to follow the OS light/dark setting.
                expected_keys.update({
                    "window.autoDetectColorScheme": True,
                    "workbench.colorTheme": "waterproof-light",
                    "workbench.preferredLightColorTheme": "waterproof-light",
                    "workbench.preferredDarkColorTheme": "waterproof-dark",
                })
            for key, expected in expected_keys.items():
                actual = settings.get(key)
                if actual != expected:
                    errors.append(f"settings.json: {key} = {actual!r}, expected {expected!r}")
        except json.JSONDecodeError as e:
            errors.append(f"settings.json: invalid JSON: {e}")
    else:
        errors.append("Missing: vscodium/data/user-data/User/settings.json")

    # Workspace settings (project/.vscode/settings.json) — bundle-critical
    # values must also be present here because workspace settings override
    # user settings in VS Code.
    ws_settings_path = bundle_root / "project" / ".vscode" / "settings.json"
    if ws_settings_path.is_file():
        try:
            ws_settings = json.loads(ws_settings_path.read_text())
            ws_expected = {
                "security.workspace.trust.enabled": False,
                "lean4.automaticallyBuildDependencies": False,
            }
            if waterproof:
                ws_expected.update({
                    # Restrict Waterproof to its Lean language server: the
                    # bundle ships no Rocq/coq-lsp for it to probe for.
                    "waterproof.skipLaunchChecks": "lean4",
                    # Waterproof's custom editor rejects CRLF documents and
                    # warns that trimming can alter proof documents.
                    "files.eol": "\n",
                    "files.trimTrailingWhitespace": False,
                    "workbench.iconTheme": "waterproof-icons",
                })
            for key, expected in ws_expected.items():
                actual = ws_settings.get(key)
                if actual != expected:
                    errors.append(
                        f"workspace settings.json: {key} = {actual!r}, expected {expected!r}"
                    )

            if waterproof:
                # Checked as a subset: _patch_workspace_settings merges nested
                # dicts, so a project may contribute its own associations.
                assoc = ws_settings.get("workbench.editorAssociations")
                if not isinstance(assoc, dict):
                    errors.append(
                        "workspace settings.json: workbench.editorAssociations "
                        f"= {assoc!r}, expected an object mapping '*.lean' to "
                        "Waterproof's custom editor"
                    )
                elif assoc.get("*.lean") != "waterproofTue.waterproofEditor":
                    errors.append(
                        "workspace settings.json: "
                        f"workbench.editorAssociations['*.lean'] = "
                        f"{assoc.get('*.lean')!r}, expected "
                        "'waterproofTue.waterproofEditor' — Lean files would "
                        "open in the plain text editor instead"
                    )

                # Theme keys are user-scoped only. A workspace colorTheme
                # would override the student's OS-driven light/dark choice,
                # so assemble.py strips these from workspace settings.
                for key in (
                    "window.autoDetectColorScheme",
                    "workbench.colorTheme",
                    "workbench.preferredLightColorTheme",
                    "workbench.preferredDarkColorTheme",
                ):
                    if key in ws_settings:
                        errors.append(
                            f"workspace settings.json: {key} must not be set "
                            "at workspace scope (it would override the "
                            "user-level OS appearance follow)"
                        )
        except json.JSONDecodeError as e:
            errors.append(f"workspace settings.json: invalid JSON: {e}")
    else:
        errors.append("Missing: project/.vscode/settings.json")

    # --- Platform-specific shared libraries ---
    if is_windows:
        if not (bundle_root / "lean" / "bin" / "libleanshared.dll").is_file():
            errors.append("Missing critical DLL: lean/bin/libleanshared.dll")

        # git shim: must be at git/cmd/git.exe so the launcher's PATH entry
        # resolves. We don't try to execute it here (Tier 1 runs on Linux too),
        # but we verify it is a real Windows PE image: the DOS header must
        # start with "MZ" and the PE header at the offset stored at 0x3C
        # must begin with "PE\0\0". This catches native compilers that
        # silently produce ELF/Mach-O binaries with a .exe name.
        git_shim = bundle_root / "git" / "cmd" / "git.exe"
        if not git_shim.is_file():
            errors.append("Missing git shim: git/cmd/git.exe")
        else:
            with open(git_shim, "rb") as f:
                dos = f.read(0x40)
            if len(dos) < 0x40 or dos[:2] != b"MZ":
                errors.append(
                    f"git/cmd/git.exe is not a PE image (DOS magic: {dos[:4]!r})"
                )
            else:
                e_lfanew = int.from_bytes(dos[0x3C:0x40], "little")
                with open(git_shim, "rb") as f:
                    f.seek(e_lfanew)
                    pe_sig = f.read(4)
                if pe_sig != b"PE\x00\x00":
                    errors.append(
                        f"git/cmd/git.exe has bad PE signature at 0x{e_lfanew:X}: "
                        f"{pe_sig!r}"
                    )
            # Shim must be tiny — anything above ~200 KB means MinGit
            # crept back in.
            size = git_shim.stat().st_size
            if size > 256 * 1024:
                errors.append(
                    f"git/cmd/git.exe is too large ({size} bytes); "
                    f"expected <256 KB for the shim"
                )
    elif platform.startswith("darwin"):
        if not (bundle_root / "lean" / "lib" / "lean" / "libleanshared.dylib").is_file():
            errors.append("Missing critical dylib: lean/lib/lean/libleanshared.dylib")

    # --- macOS framework symlinks ---
    if platform.startswith("darwin"):
        framework = bundle_root / "vscodium" / "VSCodium.app" / "Contents" / "Frameworks"
        ef = framework / "Electron Framework.framework"
        expected_symlinks = [
            ef / "Versions" / "Current",
            ef / "Electron Framework",
            ef / "Resources",
            ef / "Libraries",
            ef / "Helpers",
        ]
        for s in expected_symlinks:
            if s.exists() and not s.is_symlink():
                errors.append(f"Should be a symlink but is a regular file/dir: {s.relative_to(bundle_root)}")
            elif not s.exists():
                errors.append(f"Missing framework symlink: {s.relative_to(bundle_root)}")

    # --- Manifest uses path deps (not git) ---
    manifest_path = bundle_root / "project" / "lake-manifest.json"
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text())
            git_deps = [
                pkg["name"]
                for pkg in manifest.get("packages", [])
                if pkg.get("type") == "git"
            ]
            if git_deps:
                errors.append(
                    f"Manifest still has git deps (should be path): {', '.join(git_deps)}"
                )
        except json.JSONDecodeError as e:
            errors.append(f"lake-manifest.json: invalid JSON: {e}")

    return errors


def main():
    if len(sys.argv) < 2:
        print(
            f"Usage: {sys.argv[0]} <bundle_root> [--platform windows] "
            "[--waterproof]"
        )
        sys.exit(1)

    bundle_root = Path(sys.argv[1])
    platform = "windows"
    if "--platform" in sys.argv:
        idx = sys.argv.index("--platform")
        if idx + 1 < len(sys.argv):
            platform = sys.argv[idx + 1]
    waterproof = "--waterproof" in sys.argv

    errors = verify(bundle_root, platform, waterproof=waterproof)

    if errors:
        print(f"FAILED: {len(errors)} error(s) found:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        frontend = "Waterproof" if waterproof else "lean4"
        print(f"OK: All structural checks passed ({frontend} bundle)")
        sys.exit(0)


if __name__ == "__main__":
    main()
