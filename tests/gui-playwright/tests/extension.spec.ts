/**
 * Tier 6: Waterproof extension installation smoke test.
 *
 * Verifies that VSCodium loads the Waterproof extension through portable-mode
 * auto-discovery (no --extensions-dir flag), and that a proof sheet opens in
 * Waterproof's custom editor rather than as plain Lean source.
 *
 * These run BEFORE infoview.spec.ts (alphabetical order) so a missing or dead
 * extension fails fast here instead of letting the goal tests time out.
 */
import { test, expect } from '@playwright/test';
import { launchVSCodium, closeVSCodium, LaunchResult } from '../helpers/launch';
import { findEditorFrame } from '../helpers/frames';
import { openSheet, SHEET_BASENAME } from '../helpers/sheet';
import * as fs from 'fs';

let result: LaunchResult;

test.beforeAll(async () => {
    fs.mkdirSync('test-results', { recursive: true });
    result = await launchVSCodium();
});

test.afterAll(async () => {
    if (result) {
        await closeVSCodium(result);
    }
});

test('Waterproof extension is installed and activated', async () => {
    const page = result.page;
    await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });

    // Open the Extensions sidebar via command palette.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+Shift+KeyX`);

    // Wait for the Extensions view to appear.
    await page.waitForSelector('.extensions-list', { timeout: 15_000 });

    await page.screenshot({ path: 'test-results/extension-sidebar.png' });

    const entry = page.locator('.extension-list-item', { hasText: /waterproof/i });
    expect(await entry.count(),
        'Waterproof should appear in the Extensions sidebar — if it does not, ' +
        'VSCodium portable mode failed to auto-discover data/extensions/',
    ).toBeGreaterThan(0);
});

test('proof sheet opens in the Waterproof custom editor', async () => {
    const page = result.page;
    await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });

    await openSheet(page);

    // The sheet must resolve through workbench.editorAssociations to
    // waterproofTue.waterproofEditor. If the association or the extension's
    // custom-editor priority bump is missing, VS Code falls back to the plain
    // text editor and no Waterproof webview is ever created.
    const editorFrame = await findEditorFrame(result.browser, 120_000);

    // Named project-exercise.png for continuity: this is the shot the Pages
    // site and the README table publish as the "Project" column.
    await page.screenshot({ path: 'test-results/project-exercise.png' });

    const doc = await editorFrame.evaluate(() => ({
        title: document.title,
        format: document.body.getAttribute('format'),
        theme: document.body.getAttribute('data-vscode-theme-id'),
    }));

    // format="lean" is the custom editor reporting which genre it opened.
    expect(doc.format,
        'The Waterproof editor should have opened the sheet in its Lean genre',
    ).toBe('lean');

    // The bundle pins the Waterproof themes in the portable user settings;
    // seeing one applied proves those settings reached VSCodium.
    expect(doc.theme).toMatch(/^waterproof-/);

    const tabs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.tab'))
            .map(e => (e as HTMLElement).innerText.trim()),
    );
    expect(tabs.join(' | ')).toContain(SHEET_BASENAME);
});

test('the Lean checker is the one Waterproof started', async () => {
    const page = result.page;

    // The bundle pins waterproof.skipLaunchChecks to "lean4" so Waterproof
    // starts only its Lean language server and never probes for coq-lsp,
    // which this bundle deliberately does not ship. Waterproof advertises the
    // running checker in the status bar.
    const statusbar = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.statusbar-item'))
            .map(e => (e as HTMLElement).innerText.trim())
            .filter(Boolean)
            .join(' | '),
    );
    console.log(`  Status bar: ${statusbar}`);

    expect(statusbar,
        'Status bar should advertise the Lean checker. If it names Rocq/coq-lsp ' +
        'or is absent, waterproof.skipLaunchChecks did not take effect.',
    ).toMatch(/Waterproof checker \(lean4\)/i);
});

test('the custom editor renders proof-sheet cells', async () => {
    // Waterproof builds the document from ProseMirror nodes. Read-only Lean
    // code cells are mounted as CodeMirror instances (.cm-editor), prose as
    // .markdown-view, and the student-editable blocks as
    // <WaterproofInput class="inputarea">. Seeing all three proves the sheet
    // was parsed as a Waterproof document rather than dumped as raw text.
    const editorFrame = await findEditorFrame(result.browser, 60_000);

    const cells = await editorFrame.evaluate(() => ({
        code: document.querySelectorAll('.cm-editor').length,
        markdown: document.querySelectorAll('.markdown-view').length,
        inputs: document.querySelectorAll('waterproofinput').length,
    }));

    console.log(`  Waterproof cells: ${JSON.stringify(cells)}`);

    expect(cells.markdown, 'sheet prose should render as markdown cells').toBeGreaterThan(0);
    expect(cells.code, 'sheet Lean blocks should render as CodeMirror cells').toBeGreaterThan(0);
    expect(cells.inputs,
        `${SHEET_BASENAME} contains :::input exercise blocks; none rendered`,
    ).toBeGreaterThan(0);
});
