// *****************************************************************************
// Model Selector Component
// Dropdown for selecting AI models
// *****************************************************************************

import * as React from '@theia/core/shared/react';
import { AIModelConfig } from './model-selector-service';

export interface ModelSelectorProps {
    models: AIModelConfig[];
    selectedModelId: string | undefined;
    onModelSelect: (modelId: string) => void;
    disabled?: boolean;
    className?: string;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
    models,
    selectedModelId,
    onModelSelect,
    disabled = false,
    className = ''
}) => {
    const handleChange = React.useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        onModelSelect(event.target.value);
    }, [onModelSelect]);

    const selectedModel = models.find(m => m.id === selectedModelId);

    if (models.length === 0) {
        return null;
    }

    return (
        <div className={`theia-model-selector ${className}`}>
            <select
                value={selectedModelId || ''}
                onChange={handleChange}
                disabled={disabled}
                className="theia-model-selector-dropdown"
                title={selectedModel ? `${selectedModel.name} (${selectedModel.vendor})` : 'Select a model'}
            >
                {models.map(model => (
                    <option key={model.id} value={model.id}>
                        {model.name}
                    </option>
                ))}
            </select>
        </div>
    );
};

// Compact version for toolbar
export const ModelSelectorCompact: React.FC<ModelSelectorProps> = ({
    models,
    selectedModelId,
    onModelSelect,
    disabled = false
}) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const dropdownRef = React.useRef<HTMLDivElement>(null);

    const selectedModel = models.find(m => m.id === selectedModelId);

    // Close dropdown when clicking outside
    React.useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleSelect = React.useCallback((modelId: string) => {
        onModelSelect(modelId);
        setIsOpen(false);
    }, [onModelSelect]);

    if (models.length === 0) {
        return null;
    }

    return (
        <div className="theia-model-selector-compact" ref={dropdownRef}>
            <button
                className="theia-model-selector-button"
                onClick={() => setIsOpen(!isOpen)}
                disabled={disabled}
                title={selectedModel ? `Model: ${selectedModel.name}` : 'Select a model'}
            >
                <span className="codicon codicon-hubot" />
                <span className="model-name">{selectedModel?.name || 'Model'}</span>
                <span className="codicon codicon-chevron-down" />
            </button>
            {isOpen && (
                <div className="theia-model-selector-menu">
                    {models.map(model => (
                        <div
                            key={model.id}
                            className={`theia-model-selector-item ${model.id === selectedModelId ? 'selected' : ''}`}
                            onClick={() => handleSelect(model.id)}
                        >
                            <span className="model-name">{model.name}</span>
                            <span className="model-vendor">{model.vendor}</span>
                            {model.id === selectedModelId && (
                                <span className="codicon codicon-check" />
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
