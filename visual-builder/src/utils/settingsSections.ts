// The settings sections' names, shared by the settings view, the palette
// and the command layer, so a renamed section renames everywhere.

import type { SettingsSection } from '../store/useStore';

export const SECTION_LABEL: Record<SettingsSection, string> = {
  general: 'General', regions: 'Regions', exploration: 'Exploration', logs: 'Logs', audit: 'Audit trail',
  sessions: 'Dev sessions', storage: 'Storage', projects: 'Projects', about: 'About',
};
