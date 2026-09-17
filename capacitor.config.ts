import type { CapacitorConfig } from '@capacitor/cli'

/**
 * iOS shell for the 梭哈 web app.
 *
 * The whole game is bundled from `dist/` and runs inside a WKWebView — the
 * engine, the AI, the provably-fair shuffle and the local chip bankroll all work
 * offline because nothing is fetched at runtime except the card art, which is
 * bundled too.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */
const config: CapacitorConfig = {
  appId: 'com.showhand.stud',
  appName: 'Showhand',
  webDir: 'dist',
  ios: {
    // Let the CSS own the layout: `100dvh` already accounts for the visual
    // viewport, and styles.css pads for the safe areas itself.
    contentInset: 'never',
    backgroundColor: '#06090c',
    limitsNavigationsToAppBoundDomains: false,
  },
}

export default config
