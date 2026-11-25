import type { Page } from "@playwright/test";

/** CSS px of a Galaxy Z Fold7 (cover 1080 x 2520 and inner 1968 x 2184 at DPR 2.625): folded it is a phone, open a tablet. */
export const FOLD7 = { folded: { width: 412, height: 960 }, open: { width: 750, height: 832 } } as const;

/**
 * Resizes the window and the screen together, as folding or unfolding a device does: a phone turned on its side keeps
 * its screen, so only a fold moves a touch device between the phone and the tablet layouts (width-tier.ts).
 */
export async function fold(page: Page, size: { readonly width: number; readonly height: number }): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    ...size,
    screenWidth: size.width,
    screenHeight: size.height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await page.setViewportSize(size);
}
