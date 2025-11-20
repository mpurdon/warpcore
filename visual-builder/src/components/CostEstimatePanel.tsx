import { DollarSign, TrendingUp } from 'lucide-react';
import { useStore } from '../store/useStore';
import { estimateCost, formatCost } from '../utils/costEstimation';
import { useMemo } from 'react';

export default function CostEstimatePanel() {
  const { nodes } = useStore();

  const { total, estimates } = useMemo(() => estimateCost(nodes), [nodes]);

  if (nodes.length === 0) {
    return null;
  }

  return (
    <div className="absolute top-4 right-4 bg-white rounded-lg shadow-lg border border-gray-200 p-4 w-80">
      <div className="flex items-center gap-2 mb-3">
        <DollarSign size={18} className="text-green-600" />
        <h3 className="font-semibold">Estimated Monthly Cost</h3>
      </div>

      <div className="text-3xl font-bold text-gray-900 mb-4">
        {formatCost(total)}
        <span className="text-sm font-normal text-gray-500 ml-2">/month</span>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {estimates.map((estimate) => (
          <div key={estimate.resourceId} className="border-t border-gray-100 pt-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-gray-700">
                {estimate.resourceId}
              </span>
              <span className="text-sm font-semibold text-gray-900">
                {formatCost(estimate.monthlyCost)}
              </span>
            </div>
            {estimate.breakdown.length > 0 && (
              <div className="ml-2 space-y-1">
                {estimate.breakdown.map((item, index) => (
                  <div key={index} className="flex items-center justify-between text-xs text-gray-500">
                    <span>{item.item}</span>
                    <span>{formatCost(item.cost)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-200 text-xs text-gray-500">
        <div className="flex items-center gap-1">
          <TrendingUp size={12} />
          <span>Estimates based on typical usage patterns</span>
        </div>
      </div>
    </div>
  );
}
