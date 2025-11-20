import { X, FileText, Rocket, Star, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useStore } from '../store/useStore';
import { builtInTemplates, loadCustomTemplates, saveCustomTemplate, deleteCustomTemplate, Template } from '../utils/templates';

interface Props {
  onClose: () => void;
}

export default function TemplateModal({ onClose }: Props) {
  const { nodes, edges, setNodes, setEdges } = useStore();
  const [customTemplates, setCustomTemplates] = useState(loadCustomTemplates());
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');

  const handleLoadTemplate = (template: Template) => {
    setNodes(template.nodes);
    setEdges(template.edges);
    onClose();
  };

  const handleSaveTemplate = () => {
    if (!templateName.trim()) {
      alert('Please enter a template name');
      return;
    }

    const template = saveCustomTemplate(templateName, templateDescription, nodes, edges);
    setCustomTemplates([...customTemplates, template]);
    setTemplateName('');
    setTemplateDescription('');
    setShowSaveDialog(false);
  };

  const handleDeleteTemplate = (templateId: string) => {
    if (confirm('Are you sure you want to delete this template?')) {
      deleteCustomTemplate(templateId);
      setCustomTemplates(customTemplates.filter(t => t.id !== templateId));
    }
  };

  const categoryIcons = {
    starter: FileText,
    production: Rocket,
    custom: Star,
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[800px] max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Templates</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSaveDialog(true)}
              className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm flex items-center gap-2"
            >
              <Plus size={16} />
              Save Current as Template
            </button>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 rounded"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Built-in Templates */}
          <div className="mb-8">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Built-in Templates</h3>
            <div className="grid grid-cols-2 gap-4">
              {builtInTemplates.map((template) => {
                const Icon = categoryIcons[template.category];
                return (
                  <div
                    key={template.id}
                    onClick={() => handleLoadTemplate(template)}
                    className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-blue-100 rounded">
                        <Icon size={20} className="text-blue-600" />
                      </div>
                      <div className="flex-1">
                        <h4 className="font-semibold text-gray-900 mb-1">{template.name}</h4>
                        <p className="text-sm text-gray-600">{template.description}</p>
                        <div className="mt-2 text-xs text-gray-500">
                          {template.nodes.length} resources
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Custom Templates */}
          {customTemplates.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Custom Templates</h3>
              <div className="grid grid-cols-2 gap-4">
                {customTemplates.map((template) => {
                  const Icon = categoryIcons[template.category];
                  return (
                    <div
                      key={template.id}
                      className="border border-gray-200 rounded-lg p-4 hover:border-blue-400 transition-colors group"
                    >
                      <div className="flex items-start gap-3">
                        <div className="p-2 bg-purple-100 rounded">
                          <Icon size={20} className="text-purple-600" />
                        </div>
                        <div className="flex-1">
                          <h4 className="font-semibold text-gray-900 mb-1">{template.name}</h4>
                          <p className="text-sm text-gray-600">{template.description}</p>
                          <div className="mt-2 text-xs text-gray-500">
                            {template.nodes.length} resources
                          </div>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleLoadTemplate(template)}
                            className="p-1 hover:bg-blue-100 rounded text-blue-600"
                            title="Load template"
                          >
                            <FileText size={16} />
                          </button>
                          <button
                            onClick={() => handleDeleteTemplate(template.id)}
                            className="p-1 hover:bg-red-100 rounded text-red-600"
                            title="Delete template"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Save Dialog */}
        {showSaveDialog && (
          <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
            <div className="bg-white rounded-lg shadow-xl w-[500px] p-6">
              <h3 className="text-lg font-semibold mb-4">Save as Template</h3>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Template Name
                  </label>
                  <input
                    type="text"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="My Custom Template"
                    className="w-full px-3 py-2 border border-gray-300 rounded"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    value={templateDescription}
                    onChange={(e) => setTemplateDescription(e.target.value)}
                    placeholder="Describe what this template is for..."
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded"
                  />
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-2">
                <button
                  onClick={() => setShowSaveDialog(false)}
                  className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveTemplate}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  Save Template
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
