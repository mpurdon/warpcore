import { DollarSign, ChevronDown, ChevronUp } from 'lucide-react';
import { useStore } from '../store/useStore';
import { estimateCost, formatCost, formatExecutions, EXECUTION_STEPS } from '../utils/costEstimation';
import { useMemo, useState } from 'react';

export default function CostEstimatePanel() {
  const { nodes, executionsPerMonth, setExecutionsPerMonth } = useStore();
  const [isExpanded, setIsExpanded] = useState(false);

  const { total, estimates } = useMemo(
    () => estimateCost(nodes, executionsPerMonth),
    [nodes, executionsPerMonth]
  );

  // Find the current step index for the slider
  const currentStepIndex = EXECUTION_STEPS.findIndex(step => step === executionsPerMonth);
  const sliderValue = currentStepIndex >= 0 ? currentStepIndex : 5; // Default to 100K (index 5)

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const stepIndex = parseInt(e.target.value, 10);
    setExecutionsPerMonth(EXECUTION_STEPS[stepIndex]);
  };

  if (nodes.length === 0) {
    return null;
  }

  return (
    <div className="absolute top-4 right-4 bg-surface rounded-lg shadow-lg border border-gray-200 w-72">
      {/* Accordion Header - Always Visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full p-3 flex items-center justify-between hover:bg-gray-50 rounded-t-lg transition-colors"
      >
        <div className="flex items-center gap-2">
          <DollarSign size={18} className="text-green-600" />
          <span className="font-semibold text-gray-800">Est. Cost</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xl font-bold text-gray-900">{formatCost(total)}</span>
          {isExpanded ? (
            <ChevronUp size={18} className="text-gray-400" />
          ) : (
            <ChevronDown size={18} className="text-gray-400" />
          )}
        </div>
      </button>

      {/* Executions Slider - Always Visible */}
      <div className="px-3 pb-3">
        <div className="p-2 bg-gray-50 rounded-lg">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-gray-600">Monthly Executions</span>
            <span className="text-xs font-semibold text-blue-600">
              {formatExecutions(executionsPerMonth)}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max={EXECUTION_STEPS.length - 1}
            value={sliderValue}
            onChange={handleSliderChange}
            className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
          />
          <div className="flex justify-between text-xs text-gray-400 mt-0.5">
            <span>1</span>
            <span>1M</span>
          </div>
        </div>
      </div>

      {/* Expandable Cost Breakdown */}
      {isExpanded && (
        <div className="border-t border-gray-200 p-3">
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {estimates.map((estimate) => (
              <div key={estimate.resourceId} className="border-b border-gray-100 pb-2 last:border-b-0">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-700 truncate max-w-[150px]">
                    {estimate.resourceId}
                  </span>
                  <span className="text-sm font-semibold text-gray-900">
                    {formatCost(estimate.monthlyCost)}
                  </span>
                </div>
                {estimate.breakdown.length > 0 && (
                  <div className="ml-2 space-y-0.5">
                    {estimate.breakdown.map((item, index) => (
                      <div key={index} className="flex items-center justify-between text-xs text-gray-500">
                        <span className="truncate max-w-[120px]">{item.item}</span>
                        <span>{formatCost(item.cost)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
