/**
 * Tier 6: Waterproof bundle GUI smoke tests.
 *
 * Verifies that editing a proof sheet gets real feedback from the Lean server
 * Waterproof spawns, that the goals panel renders proof state, and that
 * nothing the bundle trimmed is missing at elaboration time.
 *
 * Test order matters and these share one VSCodium instance. Waterproof's
 * checker stays idle on a freshly opened sheet — measured here, the Problems
 * count sat at zero and the panel read "No info found." for over a minute of
 * idling, then responded within seconds of an edit. So the editing test runs
 * first and doubles as the trigger that produces proof state for the test
 * after it.
 */
import { test, expect } from '@playwright/test';
import { launchVSCodium, closeVSCodium, LaunchResult } from '../helpers/launch';
import { findInfoviewFrame, findEditorFrame, waitForInfoviewText } from '../helpers/frames';
import { openSheet } from '../helpers/sheet';
import { Page } from 'playwright';
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

/** Read the error count from VS Code's Problems status item. */
async function problemCount(page: Page): Promise<number> {
    const text = await page.evaluate(() => {
        const item = document.querySelector('[id*="status.problems"]');
        return item ? (item as HTMLElement).innerText.trim() : '';
    }).catch(() => '');
    const match = text.match(/(\d+)/);
    return match ? parseInt(match[1]) : -1;
}

test('typing in an input area produces diagnostic feedback', async () => {
    test.setTimeout(600_000);

    const page = result.page;
    await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });

    await openSheet(page);
    const editorFrame = await findEditorFrame(result.browser, 120_000);

    // Let the sheet settle before sampling, so the baseline reflects a quiet
    // checker rather than a check still in flight.
    await page.waitForTimeout(20_000);
    const baseline = await problemCount(page);
    console.log(`  Baseline problem count: ${baseline}`);
    expect(baseline, 'could not read the Problems status item').toBeGreaterThanOrEqual(0);

    // Type nonsense into the first student input area — the editable block of
    // an exercise, unlike the read-only CodeMirror cells. The bundle under
    // test is disposable, and the edit is never saved to disk.
    await editorFrame.locator('waterproofinput').first().click({ timeout: 30_000 });
    await page.keyboard.type('This is not a tactic', { delay: 50 });

    const deadline = Date.now() + 300_000;
    let current = baseline;
    while (Date.now() < deadline) {
        current = await problemCount(page);
        if (current > baseline) break;
        await page.waitForTimeout(2000);
    }

    await page.screenshot({ path: 'test-results/interaction-error.png' });

    expect(current,
        `Typing nonsense into an input area should raise the error count above ` +
        `the baseline of ${baseline}. If it does not, the Lean language server ` +
        `Waterproof spawns via \`lake serve\` is not running or not reporting ` +
        `diagnostics.`,
    ).toBeGreaterThan(baseline);
});

test('infoview renders Lean proof state for the sheet', async () => {
    test.setTimeout(600_000);
    const page = result.page;

    const infoviewFrame = await findInfoviewFrame(result.browser, 180_000);

    // The turnstile proves the panel rendered real Lean proof state rather
    // than a placeholder — here the unsolved-goals report for the exercise the
    // caret sits in, left there by the editing test above.
    await waitForInfoviewText(infoviewFrame, '⊢', 300_000);

    await page.screenshot({ path: 'test-results/infoview-goals.png' });

    const text = await infoviewFrame.evaluate(() =>
        (document.body as HTMLElement).innerText,
    );
    console.log(`  Infoview:\n${text.slice(0, 400)}`);
});

test('infoview shows no missing-file errors', async () => {
    // The infoview renders import/elaboration errors as message entries like
    // "failed to open file '...'" or "missing data file for module ...".
    // These show up when the bundle was trimmed too aggressively — e.g.
    // stripping .ir payloads that the LSP loads at elaboration time.
    //
    // Read textContent, not innerText: Waterproof's infoview override CSS
    // hides the All Messages section outright
    // (details[data-vscode-context*=AllMessagesId]{display:none}), so an
    // innerText scan would skip exactly the errors we care about. Verified
    // against a real bundle: innerText showed "No info found." while
    // textContent carried the collapsed "All Messages ( 2)" section.
    const infoviewFrame = await findInfoviewFrame(result.browser, 60_000);
    await infoviewFrame.waitForTimeout(5_000);

    const text = await infoviewFrame.evaluate(() =>
        document.body?.textContent || ''
    );

    const badPatterns = [
        /failed to open file/i,
        /missing data file for module/i,
    ];
    const hits = badPatterns
        .map(p => text.match(p)?.[0])
        .filter((m): m is string => !!m);

    if (hits.length > 0) {
        console.log(`  Infoview text (first 2000 chars):\n${text.slice(0, 2000)}`);
    }

    expect(hits,
        'Infoview must not report missing-file errors.  If this fails, ' +
        'the bundle stripped files the LSP needs at runtime — likely a ' +
        'too-aggressive .ir prune or .lake import-closure trim.',
    ).toEqual([]);
});
