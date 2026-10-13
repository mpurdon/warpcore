import { useState, useEffect, useCallback, useMemo } from 'react';
import { rc } from '../utils/theme';
import { X } from 'lucide-react';
import {
  getValidCategories,
  getResourceInfo,
} from '../utils/connectionRules';

interface RadialMenuProps {
  position: { x: number; y: number };
  sourceNodeType: string;
  onSelect: (resourceType: string, label: string) => void;
  onClose: () => void;
}

// SVG arc path helper
function describeArc(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  const startOuter = polarToCartesian(cx, cy, outerRadius, endAngle);
  const endOuter = polarToCartesian(cx, cy, outerRadius, startAngle);
  const startInner = polarToCartesian(cx, cy, innerRadius, startAngle);
  const endInner = polarToCartesian(cx, cy, innerRadius, endAngle);

  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  return [
    'M', startOuter.x, startOuter.y,
    'A', outerRadius, outerRadius, 0, largeArcFlag, 0, endOuter.x, endOuter.y,
    'L', startInner.x, startInner.y,
    'A', innerRadius, innerRadius, 0, largeArcFlag, 1, endInner.x, endInner.y,
    'Z',
  ].join(' ');
}

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleInDegrees: number
): { x: number; y: number } {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians),
  };
}

// Get position for icon/text in the middle of a slice
function getSliceCenter(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number
): { x: number; y: number } {
  const midAngle = (startAngle + endAngle) / 2;
  const midRadius = (innerRadius + outerRadius) / 2;
  return polarToCartesian(cx, cy, midRadius, midAngle);
}

export default function RadialMenu({
  position,
  sourceNodeType,
  onSelect,
  onClose,
}: RadialMenuProps) {
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);

  // Get all valid categories with their resources
  const categories = useMemo(() => {
    return getValidCategories(sourceNodeType);
  }, [sourceNodeType]);

  // Flatten all resources for simple view
  const allResources = useMemo(() => {
    return categories.flatMap(cat => cat.resources);
  }, [categories]);

  // If no valid targets, close immediately (but log for debugging)
  useEffect(() => {
    if (categories.length === 0) {
      console.log('RadialMenu: No categories for sourceType:', sourceNodeType);
      onClose();
    } else {
      console.log('RadialMenu: Showing', categories.length, 'categories for', sourceNodeType);
    }
  }, [categories, onClose, sourceNodeType]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Handle click outside
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // Source resource info for center
  const sourceInfo = getResourceInfo(sourceNodeType);

  // Determine layout based on number of resources
  const useSimpleLayout = allResources.length <= 6;

  // Dimensions - use larger size for complex layout to fit outer ring + text labels
  const cx = useSimpleLayout ? 150 : 200;
  const cy = useSimpleLayout ? 150 : 200;
  const centerRadius = 40;
  const gapAngle = 6;

  // For simple layout: show all resources in a single ring
  // For complex layout: show categories in inner ring, resources in outer ring on hover

  if (useSimpleLayout) {
    // Simple single-ring layout for few resources
    const ringInner = 55;
    const ringOuter = 110;
    const sliceAngle = allResources.length > 0
      ? (360 - allResources.length * gapAngle) / allResources.length
      : 0;

    return (
      <>
        {/* Full-screen click capture layer - closes menu when clicking outside */}
        <div
          className="radial-menu-overlay"
          onMouseDown={(e) => {
            // Close menu and let the click pass through to canvas
            onClose();
            // Re-dispatch click to element underneath after a microtask
            // This resets React Flow's connection state
            const x = e.clientX;
            const y = e.clientY;
            requestAnimationFrame(() => {
              const elementBelow = document.elementFromPoint(x, y);
              if (elementBelow) {
                elementBelow.dispatchEvent(new MouseEvent('mousedown', {
                  bubbles: true,
                  cancelable: true,
                  clientX: x,
                  clientY: y,
                  view: window,
                }));
                elementBelow.dispatchEvent(new MouseEvent('mouseup', {
                  bubbles: true,
                  cancelable: true,
                  clientX: x,
                  clientY: y,
                  view: window,
                }));
              }
            });
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 999,
          }}
        />
        <div
          className="radial-menu-backdrop"
          onClick={handleBackdropClick}
          style={{
            position: 'absolute',
            left: position.x - cx,
            top: position.y - cy,
            width: cx * 2,
            height: cx * 2,
            zIndex: 1000,
          }}
        >
          <svg width={cx * 2} height={cy * 2} className="radial-menu" style={{ opacity: 0.95 }}>
          {/* Semi-transparent background circle */}
          <circle cx={cx} cy={cy} r={ringOuter + 5} fill="white" fillOpacity={0.7} />
          {/* Center circle with source icon */}
          <circle cx={cx} cy={cy} r={centerRadius} fill={rc('var(--c-gray-100)')} stroke={rc('var(--c-gray-200)')} strokeWidth={2} />
          {sourceInfo && (
            <foreignObject x={cx - 12} y={cy - 12} width={24} height={24}>
              <sourceInfo.icon size={24} color={rc(sourceInfo.color)} />
            </foreignObject>
          )}

          {/* Close button */}
          <g
            onClick={onClose}
            style={{ cursor: 'pointer' }}
            className="radial-slice"
          >
            <circle cx={cx} cy={cy - centerRadius - 20} r={14} fill={rc('var(--c-red-100)')} stroke={rc('var(--c-red-200)')} strokeWidth={1} />
            <foreignObject x={cx - 8} y={cy - centerRadius - 28} width={16} height={16}>
              <X size={16} color={rc('var(--c-red-600)')} />
            </foreignObject>
          </g>

          {/* Resource slices */}
          {allResources.map((resource, index) => {
            const startAngle = index * (sliceAngle + gapAngle);
            const endAngle = startAngle + sliceAngle;
            const center = getSliceCenter(cx, cy, ringInner, ringOuter, startAngle, endAngle);

            return (
              <g
                key={resource.type}
                className="radial-slice"
                onClick={() => onSelect(resource.type, resource.label)}
                style={{ cursor: 'pointer' }}
              >
                <path
                  d={describeArc(cx, cy, ringInner, ringOuter, startAngle, endAngle)}
                  fill={rc('var(--c-white)')}
                  stroke={rc(resource.color)}
                  strokeWidth={2}
                />
                <foreignObject
                  x={center.x - 12}
                  y={center.y - 20}
                  width={24}
                  height={24}
                  style={{ pointerEvents: 'none' }}
                >
                  <resource.icon size={24} color={rc(resource.color)} />
                </foreignObject>
                <text
                  x={center.x}
                  y={center.y + 18}
                  textAnchor="middle"
                  fontSize="10"
                  fill={rc('var(--c-gray-700)')}
                  fontWeight="500"
                  style={{ pointerEvents: 'none' }}
                >
                  {resource.label}
                </text>
              </g>
            );
          })}
        </svg>
        </div>
      </>
    );
  }

  // Complex two-ring layout for many resources
  const innerRingInner = 55;
  const innerRingOuter = 95;
  const outerRingInner = 105;
  const outerRingOuter = 155;

  const categorySliceAngle = categories.length > 0
    ? (360 - categories.length * gapAngle) / categories.length
    : 0;

  const hoveredCategoryData = hoveredCategory
    ? categories.find((c) => c.name === hoveredCategory)
    : null;

  return (
    <>
      {/* Full-screen click capture layer - closes menu when clicking outside */}
      <div
        className="radial-menu-overlay"
        onMouseDown={(e) => {
          // Close menu and let the click pass through to canvas
          onClose();
          // Re-dispatch click to element underneath after a microtask
          // This resets React Flow's connection state
          const x = e.clientX;
          const y = e.clientY;
          requestAnimationFrame(() => {
            const elementBelow = document.elementFromPoint(x, y);
            if (elementBelow) {
              elementBelow.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                view: window,
              }));
              elementBelow.dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                view: window,
              }));
            }
          });
        }}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 999,
        }}
      />
      <div
        className="radial-menu-backdrop"
        onClick={handleBackdropClick}
        style={{
          position: 'absolute',
          left: position.x - cx,
          top: position.y - cy,
          width: cx * 2,
          height: cy * 2,
          zIndex: 1000,
        }}
      >
        <svg width={cx * 2} height={cy * 2} className="radial-menu" style={{ overflow: 'visible', opacity: 0.95 }}>
          {/* Semi-transparent background circle */}
          <circle cx={cx} cy={cy} r={outerRingOuter + 5} fill="white" fillOpacity={0.7} />
        {/* Center circle with source icon */}
        <circle cx={cx} cy={cy} r={centerRadius} fill={rc('var(--c-gray-100)')} stroke={rc('var(--c-gray-200)')} strokeWidth={2} />
        {sourceInfo && (
          <foreignObject x={cx - 12} y={cy - 12} width={24} height={24}>
            <sourceInfo.icon size={24} color={rc(sourceInfo.color)} />
          </foreignObject>
        )}

        {/* Close button */}
        <g
          onClick={onClose}
          style={{ cursor: 'pointer' }}
          className="radial-slice"
        >
          <circle cx={cx} cy={cy - centerRadius - 12} r={12} fill={rc('var(--c-red-100)')} stroke={rc('var(--c-red-200)')} strokeWidth={1} />
          <foreignObject x={cx - 6} y={cy - centerRadius - 18} width={12} height={12}>
            <X size={12} color={rc('var(--c-red-600)')} />
          </foreignObject>
        </g>

        {/* Inner ring - Categories */}
        {categories.map((category, index) => {
          const startAngle = index * (categorySliceAngle + gapAngle);
          const endAngle = startAngle + categorySliceAngle;
          const isHovered = hoveredCategory === category.name;
          const center = getSliceCenter(cx, cy, innerRingInner, innerRingOuter, startAngle, endAngle);

          return (
            <g
              key={category.name}
              className="radial-slice"
              onMouseEnter={() => setHoveredCategory(category.name)}
              onClick={() => {
                // If category has only one resource, select it directly
                if (category.resources.length === 1) {
                  const resource = category.resources[0];
                  onSelect(resource.type, resource.label);
                }
              }}
              style={{ cursor: category.resources.length === 1 ? 'pointer' : 'default' }}
            >
              <path
                d={describeArc(cx, cy, innerRingInner, innerRingOuter, startAngle, endAngle)}
                fill={rc(isHovered ? category.color : 'var(--c-gray-50)')}
                stroke={rc(category.color)}
                strokeWidth={2}
              />
              <foreignObject
                x={center.x - 10}
                y={center.y - 10}
                width={20}
                height={20}
                style={{ pointerEvents: 'none' }}
              >
                <category.icon size={20} color={rc(isHovered ? 'var(--c-white)' : category.color)} />
              </foreignObject>
            </g>
          );
        })}

        {/* Outer ring - Resources in hovered category */}
        {hoveredCategoryData && hoveredCategoryData.resources.length > 1 && (
          <g className="radial-outer-ring">
            {hoveredCategoryData.resources.map((resource, index) => {
              const resourceSliceAngle =
                (360 - hoveredCategoryData.resources.length * gapAngle) /
                hoveredCategoryData.resources.length;
              const startAngle = index * (resourceSliceAngle + gapAngle);
              const endAngle = startAngle + resourceSliceAngle;
              const center = getSliceCenter(cx, cy, outerRingInner, outerRingOuter, startAngle, endAngle);

              return (
                <g
                  key={resource.type}
                  className="radial-slice"
                  onClick={() => onSelect(resource.type, resource.label)}
                  style={{ cursor: 'pointer' }}
                >
                  <path
                    d={describeArc(cx, cy, outerRingInner, outerRingOuter, startAngle, endAngle)}
                    fill={rc('var(--c-white)')}
                    stroke={rc(resource.color)}
                    strokeWidth={2}
                  />
                  <foreignObject
                    x={center.x - 8}
                    y={center.y - 16}
                    width={16}
                    height={16}
                    style={{ pointerEvents: 'none' }}
                  >
                    <resource.icon size={16} color={rc(resource.color)} />
                  </foreignObject>
                  <text
                    x={center.x}
                    y={center.y + 12}
                    textAnchor="middle"
                    fontSize="9"
                    fill={rc('var(--c-gray-700)')}
                    fontWeight="500"
                    style={{ pointerEvents: 'none' }}
                  >
                    {resource.label}
                  </text>
                </g>
              );
            })}
          </g>
        )}
        </svg>
      </div>
    </>
  );
}
