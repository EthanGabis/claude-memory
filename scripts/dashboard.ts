#!/usr/bin/env bun
/**
 * Engram Dashboard — live TUI for monitoring the memory system.
 * Usage: bun scripts/dashboard.ts [--json]
 */

import { fetchDashboardData, closeDashboardDb } from './lib/engram-data.js';
import { createScreen, updatePanels } from './dashboard/layout.js';
import type { Panels } from './dashboard/layout.js';

// ---------------------------------------------------------------------------
// --json mode: single fetch, print, exit
// ---------------------------------------------------------------------------

if (process.argv.includes('--json')) {
  const data = await fetchDashboardData({ refreshRss: true });
  console.log(JSON.stringify(data, null, 2));
  closeDashboardDb();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// TUI mode
// ---------------------------------------------------------------------------

const { screen, panels } = createScreen();

// Panel list ordered for focus cycling (1-indexed shortcut keys map here)
const panelList = [
  panels.health,
  panels.episodes,
  panels.sessions,
  panels.extractions,
  panels.log,
] as const;

let focusIndex = 0;

// --- Initial render ---
const initialData = await fetchDashboardData({ refreshRss: true });
updatePanels(panels, initialData);
screen.render();

// --- Data refresh timer (3s) ---
const dataTimer = setInterval(async () => {
  const data = await fetchDashboardData();
  updatePanels(panels, data);
  screen.render();
}, 3000);

// --- RSS refresh timer (10s) ---
const rssTimer = setInterval(async () => {
  const data = await fetchDashboardData({ refreshRss: true });
  updatePanels(panels, data);
  screen.render();
}, 10_000);

// --- Graceful shutdown ---
function shutdown() {
  clearInterval(dataTimer);
  clearInterval(rssTimer);
  closeDashboardDb();
  screen.destroy();
  process.exit(0);
}

// --- Keyboard bindings ---

// Quit
screen.key(['q', 'C-c'], () => shutdown());

// Force refresh
screen.key(['r'], async () => {
  const data = await fetchDashboardData({ refreshRss: true });
  updatePanels(panels, data);
  screen.render();
});

// Tab: cycle focus between panels
screen.key(['tab'], () => {
  focusIndex = (focusIndex + 1) % panelList.length;
  panelList[focusIndex].focus();
  screen.render();
});

// 1-5: jump to panel by number
screen.key(['1'], () => { focusIndex = 0; panelList[0].focus(); screen.render(); });
screen.key(['2'], () => { focusIndex = 1; panelList[1].focus(); screen.render(); });
screen.key(['3'], () => { focusIndex = 2; panelList[2].focus(); screen.render(); });
screen.key(['4'], () => { focusIndex = 3; panelList[3].focus(); screen.render(); });
screen.key(['5'], () => { focusIndex = 4; panelList[4].focus(); screen.render(); });

// j/k: scroll focused panel down/up
screen.key(['j'], () => {
  (screen.focused as any).scroll(1);
  screen.render();
});

screen.key(['k'], () => {
  (screen.focused as any).scroll(-1);
  screen.render();
});
