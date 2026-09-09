import { Frame, Browser } from 'playwright';

/**
 * Waterproof renders two webviews for a proof sheet, and they are told apart
 * by their DOM, not their URL:
 *
 *   - the custom editor (viewType waterproofTue.waterproofEditor), a
 *     ProseMirror document mounted on `#editor` (document title
 *     "ProseMirror Math", `<body format="lean">`);
 *   - the goals panel, which on the Lean path renders the upstream
 *     @leanprover/infoview app on `#root` (document title "Infoview").
 *
 * Note there is deliberately no `extensionId=` URL check here. The lean4
 * versions of these tests keyed off `extensionId=leanprover.lean4` in the
 * webview URL, but Waterproof's panels are served from opaque origins —
 * `vscode-webview://<hash>/fake.html?id=...` — with no extension ID anywhere
 * in the URL, so such a filter silently matches nothing. The content frame is
 * a sibling in page.frames(), not nested, so a flat scan finds it.
 */

/** Scan every webview frame of every page for one satisfying *probe*. */
async function findWebviewFrame(
    browser: Browser,
    probe: () => boolean,
    timeoutMs: number,
    description: string,
): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        for (const ctx of browser.contexts()) {
            for (const page of ctx.pages()) {
                for (const frame of page.frames()) {
                    if (!frame.url().startsWith('vscode-webview://')) continue;
                    try {
                        if (await frame.evaluate(probe).catch(() => false)) {
                            return frame;
                        }
                    } catch {
                        // Frame may have been detached mid-scan.
                    }
                }
            }
        }
        await new Promise(r => setTimeout(r, 1500));
    }

    throw new Error(`${description} not found within ${timeoutMs}ms`);
}

/**
 * Find the Lean goals panel — Waterproof's infoview webview.
 *
 * Matches as soon as the panel exists, including while it still reads
 * "No info found." (its state before the cursor is inside a proof).
 */
export async function findInfoviewFrame(
    browser: Browser,
    timeoutMs: number = 180_000,
): Promise<Frame> {
    return findWebviewFrame(
        browser,
        () => document.getElementById('root') !== null && document.title === 'Infoview',
        timeoutMs,
        'Waterproof Lean infoview frame',
    );
}

/**
 * Find the Waterproof document editor frame, once it has rendered at least one
 * cell. An empty `#editor` means the webview bundle never started, which is
 * exactly the failure worth catching.
 */
export async function findEditorFrame(
    browser: Browser,
    timeoutMs: number = 180_000,
): Promise<Frame> {
    return findWebviewFrame(
        browser,
        () => {
            const editor = document.getElementById('editor');
            return editor !== null && editor.children.length > 0;
        },
        timeoutMs,
        'Waterproof document editor frame',
    );
}

/** Wait for specific text content to appear in a webview frame. */
export async function waitForInfoviewText(
    frame: Frame,
    text: string,
    timeoutMs: number = 60_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const content = await frame.evaluate(() =>
                document.body?.innerText || ''
            );
            if (content.includes(text)) return;
        } catch {
            // Frame may have been detached/recreated
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    throw new Error(`Text "${text}" not found in frame within ${timeoutMs}ms`);
}
