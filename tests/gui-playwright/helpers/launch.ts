import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { chromium, Browser, Page } from 'playwright';

function findLauncherScript(bundleRoot: string): string {
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const exts = isWindows ? ['.cmd'] : isMac ? ['.command', '.sh'] : ['.sh'];
    for (const ext of exts) for (const name of [`Start_Lean${ext}`, `start_lean${ext}`]) {
        const p = path.join(bundleRoot, name);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(`No launcher script found in ${bundleRoot}`);
}

export interface LaunchResult {
    browser: Browser;
    page: Page;
    process: childProcess.ChildProcess;
    workspacePath: string;
    userDataDir: string;
    copiedFixtures: string[];
}

async function waitForCDP(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (resp.ok) return;
        } catch { /* not ready */ }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`CDP not available on port ${port} after ${timeoutMs}ms`);
}

function randomPort(): number {
    return 9200 + Math.floor(Math.random() * 800);
}

export async function launchVSCodium(options?: {
    fixtures?: string[];
    openFile?: string;
}): Promise<LaunchResult> {
    const bundleRoot = process.env.BUNDLE_ROOT;
    if (!bundleRoot) {
        throw new Error('BUNDLE_ROOT environment variable not set');
    }

    const launcherScript = findLauncherScript(bundleRoot);

    // Use the bundle's project directory as the workspace.
    // Waterproof spawns `lake serve` from here, so .lake/packages must be
    // present for the Lean language server to come up.
    const workspacePath = path.join(bundleRoot, 'project');

    // Waterproof tests drive the project's own proof sheets rather than
    // injected fixtures: a Waterproof document is a Verso `#doc` that has to
    // compile against WaterproofGenre, so a synthetic .lean file dropped into
    // the workspace would not render as a proof sheet at all. Callers can
    // still pass `fixtures` explicitly.
    const fixturesToUse = options?.fixtures ?? [];
    const copiedFixtures: string[] = [];
    for (const fixture of fixturesToUse) {
        const dest = path.join(workspacePath, path.basename(fixture));
        fs.copyFileSync(fixture, dest);
        copiedFixtures.push(dest);
    }

    // Kill any stale VSCodium processes to prevent "Sending env to running instance"
    if (process.platform === 'win32') {
        try { childProcess.execSync('taskkill /f /im VSCodium.exe 2>nul', { stdio: 'ignore' }); } catch { /* */ }
    } else {
        // The bracket in "[c]odium" keeps the pattern from matching the shell
        // running it: pkill -f tests full command lines, and a plain "codium"
        // pattern matches this very process, killing it before it can kill
        // anything else. execSync then throws, the catch swallows it, and the
        // stale VSCodium survives — so the next launch forwards to the old
        // instance and CDP attaches to the wrong window.
        try { childProcess.execSync('pkill -9 -f "[c]odium" 2>/dev/null || true'); } catch { /* */ }
    }

    // Use the bundle's own user-data-dir (has extension registry).
    // Clear user-state to prevent stale window restoration.
    const userDataDir = path.join(bundleRoot, 'vscodium', 'data', 'user-data');
    const userStateDir = path.join(bundleRoot, 'vscodium', 'data', 'user-state');
    try { fs.rmSync(userStateDir, { recursive: true, force: true }); } catch { /* ignore */ }

    // Also drop hot-exit backups. Waterproof edits live in the editor buffer
    // without ever touching the .lean file on disk, so without this a previous
    // run's unsaved typing is restored into the next one — the document starts
    // dirty, the diagnostic baseline is off, and published screenshots show
    // leftover text. Matters when re-running against the same bundle; CI
    // extracts a fresh one per job.
    const backupsDir = path.join(userDataDir, 'Backups');
    try { fs.rmSync(backupsDir, { recursive: true, force: true }); } catch { /* ignore */ }

    // Do NOT pass --extensions-dir: portable mode must auto-discover
    // data/extensions/ without help, just like the real student launcher.
    // Passing it explicitly would mask portable-mode detection bugs.

    // Only set test-infrastructure env vars. The launcher script owns
    // PATH, ELAN_HOME, and LEAN_PATH — that's what we're testing.
    const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        BUNDLE_ROOT: bundleRoot,
        DONT_PROMPT_WSL_INSTALL: '1',
    };

    // Running this suite from a VS Code / VSCodium integrated terminal leaks
    // the extension host's own Electron environment into the child. With
    // ELECTRON_RUN_AS_NODE=1 inherited, the bundled VSCodium starts as plain
    // Node and exits immediately trying to require() the workspace path — no
    // window, no log, and the only symptom is a CDP timeout. Strip the family.
    for (const key of Object.keys(env)) {
        if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_')) {
            delete env[key];
        }
    }

    // The bundle's own settings.json already disables workspace trust and
    // window restore (templates/settings.json + _patch_workspace_settings in
    // assemble.py).  We deliberately do NOT patch them here so that Tier 6
    // screenshots reflect the actual student experience.

    // VS Code's main IPC socket is a Unix domain socket under the user-data
    // dir, and the kernel caps those paths at 107 bytes. Past that, VSCodium
    // fails startup with `listen EINVAL` and writes no log at all, so the only
    // visible symptom is a CDP timeout. Bundle directory names are long
    // (e.g. introduction-to-proof-sheets-lean-bundle), so this is reachable in
    // CI — extract the bundle somewhere short. Fail with the real reason.
    if (process.platform !== 'win32') {
        // The socket basename is version-stamped, e.g. "1.12-main.sock".
        const socketPath = path.join(userDataDir, '0.00-main.sock');
        if (socketPath.length > 107) {
            throw new Error(
                `Bundle path is too long for VS Code's IPC socket: ` +
                `"${socketPath}" is ${socketPath.length} chars, limit is 107. ` +
                `VSCodium would exit during startup without logging. ` +
                `Extract the bundle to a shorter path (e.g. /tmp/b).`,
            );
        }
    }

    const cdpPort = randomPort();

    console.log('=== Tier 6: Playwright UI automation test ===');
    console.log(`  Launcher: ${launcherScript}`);
    console.log(`  Workspace: ${workspacePath}`);
    console.log(`  User data: ${userDataDir}`);

    // The launcher script already prepends the project path as the first
    // argument to VSCodium. We pass only the test-control flags, which the
    // launcher forwards via "$@" (Unix) or %* (Windows).
    const extraArgs = [
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${cdpPort}`,
        '--disable-gpu',
        '--no-sandbox',
        '--disable-gpu-sandbox',
        // --skip-welcome deliberately omitted: the bundle's own
        // settings.json sets workbench.startupEditor=none, and we want
        // Tier 6 to verify the real student experience.
        '--disable-updates',
        '--new-window',
    ];

    // To open a specific file within the workspace, use --goto which opens
    // the file in the same window as the workspace folder.
    //
    // Prefer opening files from inside the workbench (Quick Open) in
    // Waterproof tests: --goto is a text-editor navigation and bypasses
    // workbench.editorAssociations, so it would open a proof sheet as plain
    // Lean source instead of in Waterproof's custom editor.
    if (options?.openFile) {
        extraArgs.push('--goto', path.join(workspacePath, options.openFile));
    }

    // Spawn the real launcher script. On Unix the script uses `exec`, so
    // the bash process replaces itself with VSCodium — the child PID IS
    // the VSCodium process and process.kill() works as before.
    const isWindows = process.platform === 'win32';
    let proc: childProcess.ChildProcess;
    if (isWindows) {
        // Use cmd.exe /c to run the batch launcher. Quote any arg that
        // contains spaces; the launcher filename itself no longer has
        // spaces (Start_Lean.cmd) to avoid cmd.exe quoting pitfalls.
        const quote = (s: string) => s.includes(' ') ? `"${s}"` : s;
        const cmdLine = [quote(launcherScript), ...extraArgs.map(quote)].join(' ');
        proc = childProcess.spawn('cmd.exe', ['/d', '/c', cmdLine], {
            env,
            stdio: 'pipe',
            detached: false,
            windowsVerbatimArguments: true,
        });
    } else {
        proc = childProcess.spawn('bash', [launcherScript, ...extraArgs], {
            env,
            stdio: 'pipe',
            detached: false,
        });
    }

    proc.stdout?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.log(`  [vscodium stdout] ${msg}`);
    });
    proc.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes('which: no codium')) {
            if (msg.includes('extension') || msg.includes('Extension') ||
                msg.includes('lean') || msg.includes('activat') ||
                msg.includes('ERR')) {
                console.log(`  [vscodium] ${msg}`);
            }
        }
    });

    // Log early exit for diagnostics (especially on Windows where VSCodium
    // may fail to start through the batch launcher).
    proc.on('error', (err) => console.log(`  [vscodium spawn error] ${err.message}`));
    proc.on('exit', (code, signal) => console.log(`  [vscodium exit] code=${code} signal=${signal}`));

    console.log('  Waiting for CDP...');
    // macOS and Windows may take longer than Linux to start VSCodium.
    const cdpTimeout = process.platform === 'linux' ? 30_000 : 60_000;
    await waitForCDP(cdpPort, cdpTimeout);
    console.log('  CDP available');

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);

    // Wait a moment for pages to initialize, then find the right one
    await new Promise(r => setTimeout(r, 3000));
    let page: Page | undefined;
    for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
            const title = await p.title().catch(() => '');
            console.log(`  Found page: "${title}"`);
            if (title.includes('project')) {
                page = p;
            }
        }
    }
    // Fall back to last page if none matched
    if (!page) {
        const allPages = browser.contexts().flatMap(c => c.pages());
        page = allPages[allPages.length - 1];
    }
    if (!page) {
        throw new Error('No page found after CDP connection');
    }
    console.log(`  Using page: "${await page.title()}"`);

    return { browser, page, process: proc, workspacePath, userDataDir, copiedFixtures };
}

export async function closeVSCodium(result: LaunchResult) {
    try { await result.browser.close(); } catch { /* ignore */ }
    try { result.process.kill(); } catch { /* ignore */ }
    // On Windows the launcher uses `start` to detach VSCodium, so cmd.exe
    // exits immediately. Use taskkill to terminate VSCodium directly.
    if (process.platform === 'win32') {
        try { childProcess.execSync('taskkill /f /im VSCodium.exe 2>nul', { stdio: 'ignore' }); } catch { /* */ }
    }
    for (const f of result.copiedFixtures) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
}
