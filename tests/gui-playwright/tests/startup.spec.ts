/**
 * Tier 6: First-launch experience smoke tests (Waterproof bundle).
 *
 * Verifies that when a student launches the bundle for the first time:
 *   - No Welcome tab is shown (workbench.startupEditor = none)
 *   - No notification popups appear (git parent repo, trust, etc.)
 *
 * Uses its own VSCodium instance with NO fixture files injected, so
 * the startup behaviour matches the real student experience.
 */
import { test, expect } from '@playwright/test';
import { launchVSCodium, closeVSCodium, LaunchResult } from '../helpers/launch';
import * as fs from 'fs';

let result: LaunchResult;

test.beforeAll(async () => {
    fs.mkdirSync('test-results', { recursive: true });
    // Launch with NO fixtures — we want to see exactly what a student sees.
    result = await launchVSCodium({ fixtures: [] });
});

test.afterAll(async () => {
    if (result) {
        await closeVSCodium(result);
    }
});

test('no Welcome tab on first launch', async () => {
    const page = result.page;
    await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });

    // Give VS Code a moment to settle and open any startup tabs.
    await page.waitForTimeout(5_000);

    await page.screenshot({ path: 'test-results/startup-no-welcome.png' });

    // Check that no tab with "Welcome" or "Get Started" text is visible.
    const welcomeTab = page.locator('.tab', { hasText: /Welcome|Get Started/i });
    const count = await welcomeTab.count();
    expect(count, 'Welcome tab should not appear on startup').toBe(0);
});

test('no notification popups on startup', async () => {
    const page = result.page;
    await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });

    // Wait for notifications to potentially appear.
    await page.waitForTimeout(10_000);

    await page.screenshot({ path: 'test-results/startup-no-notifications.png' });

    // Check that no notification toasts are visible.
    const toasts = page.locator('.notifications-toasts .notification-toast');
    const count = await toasts.count();

    if (count > 0) {
        // Log which notifications appeared (for debugging CI failures).
        for (let i = 0; i < count; i++) {
            const text = await toasts.nth(i).innerText().catch(() => '<unreadable>');
            console.log(`  Unexpected notification: ${text}`);
        }
    }

    expect(count, 'No notification popups should appear on startup').toBe(0);
});

test('no trim-trailing-whitespace warning from Waterproof', async () => {
    const page = result.page;
    await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });

    // Waterproof warns when files.trimTrailingWhitespace is enabled, because
    // trimming can silently alter proof documents. The bundle pins it to false
    // in the project's workspace settings; this catches a regression there.
    await page.waitForTimeout(5_000);

    const warning = page.getByText(/Trim Trailing Whitespace/i).first();
    const visible = await warning.isVisible().catch(() => false);

    expect(visible,
        'Waterproof should not warn about Trim Trailing Whitespace — the ' +
        'bundle sets files.trimTrailingWhitespace to false in the project ' +
        'workspace settings.',
    ).toBe(false);
});

test('no Lean toolchain install prompt on first launch', async () => {
    const page = result.page;
    await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });

    // Waterproof starts the Lean server itself by spawning `lake serve`
    // (waterproof.lakePath / waterproof.lakeArgs), so it never runs the
    // lean4 extension's elan probe.  The prompt should therefore never
    // appear — but the bundled `lake` still resolves a toolchain, and if
    // the launcher's PATH scrubbing regresses it can pick up a student's
    // elan and produce the modal:
    //
    //   "Lean version 'leanprover/lean4:vX.Y.Z' of Lean project '...' is
    //    not installed.  Do you wish to install it?"
    //
    // This is *modal*, so the existing "no notification popups" check
    // (which only inspects toast notifications) misses it entirely.
    // Wait long enough for the extension to fully activate.
    await page.waitForTimeout(20_000);

    await page.screenshot({ path: 'test-results/startup-no-toolchain-prompt.png' });

    // Match by characteristic text from the prompt — works for both modal
    // dialogs and notification toasts, and survives DOM-class churn.
    const installPrompt = page.getByText(/is not installed/i).first();
    const visible = await installPrompt.isVisible().catch(() => false);

    if (visible) {
        const fullText = await installPrompt.textContent().catch(() => '<unreadable>');
        console.log(`  Toolchain install prompt visible: ${fullText}`);
    }

    expect(visible,
        '"Lean version is not installed" prompt should NOT appear. ' +
        'If this fails, the bundled Lean toolchain is not in the elan ' +
        'layout (~/.elan/toolchains/<encoded-name>/) the launcher ' +
        'registers, so a student\'s existing elan install is being asked ' +
        'to supply a toolchain it does not have.',
    ).toBe(false);
});
