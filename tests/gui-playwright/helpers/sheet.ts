import { Page } from 'playwright';

/**
 * The proof sheet the Waterproof GUI tests drive.
 *
 * This is a real exercise sheet from the bundled course, not a fixture: a
 * Waterproof document is a Verso `#doc` that must compile against
 * WaterproofGenre, so it cannot be synthesised at test time. The project is
 * pinned by REPO_REF in .github/workflows/build-and-test.yml — if that pin
 * moves and this sheet is renamed or restructured, update both together.
 */
export const SHEET_BASENAME = 'sheet1_conjunction';

/**
 * Open a workspace file through Quick Open.
 *
 * Deliberately not `--goto` / a CLI file argument: those are text-editor
 * navigations that bypass `workbench.editorAssociations`, so the sheet would
 * open as plain Lean source rather than in Waterproof's custom editor.
 */
export async function openSheet(page: Page, basename: string = SHEET_BASENAME) {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+KeyP`);
    await page.waitForSelector('.quick-input-widget', { timeout: 15_000 });
    await page.keyboard.type(basename, { delay: 30 });
    // Let the picker filter before committing to the highlighted entry.
    await page.waitForTimeout(2000);
    await page.keyboard.press('Enter');
}

