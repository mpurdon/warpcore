import { Globe } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { useAvailableRegions } from '../../utils/regionCatalog';
import RegionPicker, { summariseRegions } from '../RegionPicker';
import { SectionHeader } from './primitives';

export default function RegionsSection() {
  const { selectedRegions, setSelectedRegions } = useStore();
  const { regions, note, loading } = useAvailableRegions();

  return (
    <div>
      <SectionHeader
        icon={Globe}
        title="Regions of interest"
        description={`Checked regions are the ones offered everywhere else in the app: the Account Explorer scans these rather than all ${regions.length || 30}. Nothing selected means the profile's own region.`}
      />
      <p className="text-sm text-gray-700 mb-4">
        Currently <strong>{summariseRegions(selectedRegions)}</strong>.
      </p>
      {loading ? (
        <p className="text-sm text-gray-500">Asking the account which regions it has enabled…</p>
      ) : (
        <RegionPicker
          available={regions}
          selected={selectedRegions}
          onChange={setSelectedRegions}
          note={note}
        />
      )}
    </div>
  );
}
