// Which regions the picker can offer: the account's own enabled set when AWS
// is reachable, else a static catalogue so an offline machine still gets a
// usable picker.

import { useEffect, useState } from 'react';
import { listAwsProfiles, listRegions, preferredProfile } from './accountExplorer';
import { PLACES } from './regions';

// The static catalogue is the one the picker already groups and labels; a
// second list here had already fallen behind it.
export const FALLBACK_REGIONS = Object.keys(PLACES);

export interface AvailableRegions {
  regions: string[];
  /** Set when the live lookup failed and the fallback is in use. */
  note?: string;
  loading: boolean;
}

/**
 * The account's enabled regions, via the preferred profile. Falls back to
 * the static catalogue if that call fails - an unreachable AWS must not leave
 * the picker empty.
 */
export function useAvailableRegions(): AvailableRegions {
  const [state, setState] = useState<AvailableRegions>({ regions: [], loading: true });

  useEffect(() => {
    let cancelled = false;
    let profile = '';
    listAwsProfiles()
      .then((profiles) => {
        // The profile the operator prefers, not an arbitrary one: the first
        // profile alphabetically often has no usable credentials.
        profile = preferredProfile(profiles);
        return listRegions(profile);
      })
      .then((regions) => {
        if (!cancelled) setState({ regions, loading: false });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          regions: FALLBACK_REGIONS,
          loading: false,
          note:
            `Could not list enabled regions${profile ? ` using profile "${profile}"` : ''}; `
            + 'showing the standard set. Scan an account in the Explorer first to pick it up.',
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
