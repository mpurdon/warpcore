// Reading the review for the open project. One function, shared by the
// drawer, the palette and the command layer, so "review" means one thing.

import { useStore } from '../store/useStore';
import { projectProfile } from './accountExplorer';
import { fetchFindings } from './findings';

/** Read (or re-read) the review for the open project. Shared with the palette. */
export async function runReview(hours = 24): Promise<void> {
  const s = useStore.getState();
  const profile = projectProfile(s.environmentExtras, s.currentEnvironment);
  if (!profile || !s.configPath) return;
  s.setReviewBusy(true);
  try {
    const llm = s.prefs.assistantProvider ? { provider: s.prefs.assistantProvider, model: s.prefs.assistantModel } : undefined;
    s.setReview(await fetchFindings(profile, s.configPath, hours, llm));
  } catch (e) {
    s.setReview({ window_hours: hours, findings: [], groups: [], summary: null, model: null, notes: [], errors: { review: String(e) }, at: new Date().toISOString() });
  } finally {
    useStore.getState().setReviewBusy(false);
  }
}

