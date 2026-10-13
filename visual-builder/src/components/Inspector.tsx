// Workspace + contextual inspector. The canvas stays where it is; this panel
// shows whatever is selected - an environment opened from the toolbar, else
// a scenario opened for inspection, else the selected node, else the project - so the operator never loses context
// to look at something. See DESIGN_GUIDANCE.md §5.2.

import { useStore } from '../store/useStore';
import EnvironmentInspector from './inspector/EnvironmentInspector';
import NodeInspector from './inspector/NodeInspector';
import ProjectInspector from './inspector/ProjectInspector';
import ScenarioInspector from './inspector/ScenarioInspector';

export default function Inspector() {
  const { rightPanelVisible, inspectedEnvironment, environmentConfigs, selectedNode, nodes, inspectedScenario, scenarios } = useStore();

  if (!rightPanelVisible) return null;

  const node = selectedNode ? nodes.find((n) => n.id === selectedNode) : undefined;
  const environment = inspectedEnvironment && environmentConfigs[inspectedEnvironment] ? inspectedEnvironment : null;
  const scenario = inspectedScenario ? scenarios.find((s) => s.id === inspectedScenario) : undefined;

  return (
    <aside className="w-96 bg-surface border-l border-gray-200 flex flex-col h-full min-h-0 text-gray-900">
      {environment ? (
        <EnvironmentInspector key={environment} env={environment} />
      ) : scenario ? (
        <ScenarioInspector key={scenario.id} scenario={scenario} />
      ) : node ? (
        <NodeInspector key={node.id} node={node} />
      ) : (
        <ProjectInspector />
      )}
    </aside>
  );
}
