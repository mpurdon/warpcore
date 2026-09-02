// AWS region catalogue and geographic grouping.
//
// The group is derived from the region code's prefix rather than looked up, so
// a region AWS adds tomorrow still lands in the right group instead of
// disappearing from the picker. Display names are a lookup because there is no
// way to derive "us-east-1 is N. Virginia".

export interface RegionInfo {
  code: string;
  /** Geographic group, e.g. "US", "Europe". */
  group: string;
  /** City or area, e.g. "N. Virginia". Falls back to the code. */
  place: string;
}

// Prefix -> geographic group. Longest prefix wins, so us-gov beats us.
const GROUP_PREFIXES: [string, string][] = [
  ['us-gov', 'AWS GovCloud'],
  ['us-iso', 'AWS ISO'],
  ['cn', 'China'],
  ['us', 'US'],
  ['ca', 'Canada'],
  ['mx', 'Mexico'],
  ['sa', 'South America'],
  ['eu', 'Europe'],
  ['ap', 'Asia Pacific'],
  ['me', 'Middle East'],
  ['af', 'Africa'],
  ['il', 'Israel'],
];

// Display order for the groups, so the picker reads sensibly rather than
// alphabetically.
export const GROUP_ORDER = [
  'US', 'Canada', 'Mexico', 'South America', 'Europe',
  'Asia Pacific', 'Middle East', 'Africa', 'Israel',
  'China', 'AWS GovCloud', 'AWS ISO', 'Other',
];

const PLACES: Record<string, string> = {
  'us-east-1': 'N. Virginia',
  'us-east-2': 'Ohio',
  'us-west-1': 'N. California',
  'us-west-2': 'Oregon',
  'af-south-1': 'Cape Town',
  'ap-east-1': 'Hong Kong',
  'ap-south-1': 'Mumbai',
  'ap-south-2': 'Hyderabad',
  'ap-northeast-1': 'Tokyo',
  'ap-northeast-2': 'Seoul',
  'ap-northeast-3': 'Osaka',
  'ap-southeast-1': 'Singapore',
  'ap-southeast-2': 'Sydney',
  'ap-southeast-3': 'Jakarta',
  'ap-southeast-4': 'Melbourne',
  'ap-southeast-5': 'Malaysia',
  'ap-southeast-7': 'Thailand',
  'ca-central-1': 'Central',
  'ca-west-1': 'Calgary',
  'eu-central-1': 'Frankfurt',
  'eu-central-2': 'Zurich',
  'eu-west-1': 'Ireland',
  'eu-west-2': 'London',
  'eu-west-3': 'Paris',
  'eu-north-1': 'Stockholm',
  'eu-south-1': 'Milan',
  'eu-south-2': 'Spain',
  'il-central-1': 'Tel Aviv',
  'me-central-1': 'UAE',
  'me-south-1': 'Bahrain',
  'mx-central-1': 'Mexico',
  'sa-east-1': 'São Paulo',
};

/** Geographic group for a region code. */
export function groupForRegion(code: string): string {
  for (const [prefix, group] of GROUP_PREFIXES) {
    if (code === prefix || code.startsWith(`${prefix}-`)) return group;
  }
  return 'Other';
}

export function regionInfo(code: string): RegionInfo {
  return { code, group: groupForRegion(code), place: PLACES[code] || code };
}

/** "us-east-1 · N. Virginia", or just the code when the place is unknown. */
export function regionLabel(code: string): string {
  const place = PLACES[code];
  return place ? `${code} · ${place}` : code;
}

/** Group regions for display, in GROUP_ORDER, each group sorted by code. */
export function groupRegions(codes: string[]): [string, RegionInfo[]][] {
  const byGroup = new Map<string, RegionInfo[]>();
  for (const code of codes) {
    const info = regionInfo(code);
    if (!byGroup.has(info.group)) byGroup.set(info.group, []);
    byGroup.get(info.group)!.push(info);
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.code.localeCompare(b.code));

  return [...byGroup.entries()].sort(
    (a, b) => {
      const ai = GROUP_ORDER.indexOf(a[0]);
      const bi = GROUP_ORDER.indexOf(b[0]);
      return (ai === -1 ? GROUP_ORDER.length : ai) - (bi === -1 ? GROUP_ORDER.length : bi);
    },
  );
}
