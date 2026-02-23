/**
 * TUI layout for the Engram Dashboard.
 * Uses @unblessed/node Screen + Box widgets.
 */

import { NodeRuntime, setRuntime, Screen, Box } from '@unblessed/node';
import type { DashboardData } from './types.js';
import {
  renderHealth,
  renderEpisodes,
  renderSessions,
  renderExtractions,
  renderLog,
} from './panels.js';

export interface Panels {
  health: InstanceType<typeof Box>;
  episodes: InstanceType<typeof Box>;
  sessions: InstanceType<typeof Box>;
  extractions: InstanceType<typeof Box>;
  log: InstanceType<typeof Box>;
}

export interface DashboardScreen {
  screen: InstanceType<typeof Screen>;
  panels: Panels;
}

export function createScreen(): DashboardScreen {
  setRuntime(new NodeRuntime());
  const screen = new Screen({
    smartCSR: true,
    title: 'Engram Dashboard',
    fullUnicode: true,
  });

  // Title bar
  new Box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{center}{bold}Engram Dashboard{/bold}{/center}',
    tags: true,
    style: { fg: 'white', bg: 'blue' },
  });

  // Top-left: Daemon Health
  const health = new Box({
    parent: screen,
    top: 3,
    left: 0,
    width: '50%',
    height: 11,
    label: ' Daemon Health ',
    border: { type: 'line' },
    scrollable: true,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
      focus: { border: { fg: 'white' } },
    },
  });

  // Top-right: Episode Stats
  const episodes = new Box({
    parent: screen,
    top: 3,
    left: '50%',
    width: '50%',
    height: 11,
    label: ' Episode Stats ',
    border: { type: 'line' },
    scrollable: true,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
      focus: { border: { fg: 'white' } },
    },
  });

  // Active Sessions
  const sessions = new Box({
    parent: screen,
    top: 14,
    left: 0,
    width: '100%',
    height: 8,
    label: ' Active Sessions ',
    border: { type: 'line' },
    scrollable: true,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
      focus: { border: { fg: 'white' } },
    },
  });

  // Recent Extractions
  const extractions = new Box({
    parent: screen,
    top: 22,
    left: 0,
    width: '100%',
    height: 8,
    label: ' Recent Extractions ',
    border: { type: 'line' },
    scrollable: true,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
      focus: { border: { fg: 'white' } },
    },
  });

  // Log Tail — fills remaining space
  const log = new Box({
    parent: screen,
    top: 30,
    left: 0,
    width: '100%',
    height: '100%-32',
    label: ' Log ',
    border: { type: 'line' },
    scrollable: true,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    alwaysScroll: true,
    scrollbar: { ch: '▐', style: { fg: 'cyan' } },
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
      focus: { border: { fg: 'white' } },
    },
  });

  // Footer
  new Box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' q:quit  r:refresh  tab:focus  j/k:scroll  1-5:panels',
    tags: true,
    style: { fg: 'white', bg: 'blue' },
  });

  // Debounced resize handler
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  screen.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => screen.render(), 100);
  });

  const panels: Panels = { health, episodes, sessions, extractions, log };

  screen.render();
  return { screen, panels };
}

export function updatePanels(panels: Panels, data: DashboardData): void {
  panels.health.setContent(renderHealth(data));
  panels.episodes.setContent(renderEpisodes(data));
  panels.sessions.setContent(renderSessions(data));
  panels.extractions.setContent(renderExtractions(data));
  panels.log.setContent(renderLog(data));
}
