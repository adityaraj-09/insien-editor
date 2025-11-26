// *****************************************************************************
// Custom Model Selector Service
// Fetches available AI models from the backend
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';

export interface AIModelConfig {
    id: string;
    name: string;
    vendor: string;
    isDefault?: boolean;
    maxTokens?: number;
}

export interface ModelsResponse {
    models: AIModelConfig[];
    default: string;
}

export const ModelSelectorService = Symbol('ModelSelectorService');

export interface ModelSelectorService {
    readonly models: AIModelConfig[];
    readonly selectedModelId: string | undefined;
    readonly onModelsChanged: Event<AIModelConfig[]>;
    readonly onSelectedModelChanged: Event<string>;
    fetchModels(backendUrl: string): Promise<void>;
    selectModel(modelId: string): void;
    getSelectedModel(): AIModelConfig | undefined;
}

@injectable()
export class ModelSelectorServiceImpl implements ModelSelectorService {
    protected _models: AIModelConfig[] = [];
    protected _selectedModelId: string | undefined;
    protected _backendUrl: string = '';

    protected readonly onModelsChangedEmitter = new Emitter<AIModelConfig[]>();
    readonly onModelsChanged = this.onModelsChangedEmitter.event;

    protected readonly onSelectedModelChangedEmitter = new Emitter<string>();
    readonly onSelectedModelChanged = this.onSelectedModelChangedEmitter.event;

    get models(): AIModelConfig[] {
        return this._models;
    }

    get selectedModelId(): string | undefined {
        return this._selectedModelId;
    }

    async fetchModels(backendUrl: string): Promise<void> {
        this._backendUrl = backendUrl;
        try {
            const response = await fetch(`${backendUrl}/api/custom-chat/models`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'include',
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch models: ${response.statusText}`);
            }

            const data: ModelsResponse = await response.json();
            this._models = data.models;

            // Set default model if not already selected
            if (!this._selectedModelId && data.default) {
                this._selectedModelId = data.default;
            }

            this.onModelsChangedEmitter.fire(this._models);
        } catch (error) {
            console.error('[ModelSelectorService] Error fetching models:', error);
            // Fallback to default models if backend is unavailable
            this._models = [
                { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', vendor: 'Google', isDefault: true },
                { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', vendor: 'Google' },
                { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash', vendor: 'Google' },
            ];
            this._selectedModelId = 'gemini-2.5-pro';
            this.onModelsChangedEmitter.fire(this._models);
        }
    }

    selectModel(modelId: string): void {
        const model = this._models.find(m => m.id === modelId);
        if (model) {
            this._selectedModelId = modelId;
            this.onSelectedModelChangedEmitter.fire(modelId);
        }
    }

    getSelectedModel(): AIModelConfig | undefined {
        return this._models.find(m => m.id === this._selectedModelId);
    }
}
