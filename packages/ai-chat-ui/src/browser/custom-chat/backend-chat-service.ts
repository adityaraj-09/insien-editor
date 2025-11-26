// *****************************************************************************
// Backend Chat Service
// Sends chat messages to the custom backend for LLM processing
// *****************************************************************************

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';
import { ModelSelectorService } from './model-selector-service';
import { LocalIngestionService } from './local-ingestion-service';

export interface ChatContextFile {
    path: string;
    content: string;
    startLine?: number;
    endLine?: number;
}

export interface ChatRequest {
    projectId: string;
    sessionId?: string;
    message: string;
    model?: string;
    contextFiles?: ChatContextFile[];
}

export interface ChatResponseEdit {
    filePath: string;
    originalContent?: string;
    newContent: string;
    startLine?: number;
    endLine?: number;
    type: 'create' | 'modify' | 'delete';
}

export interface ChatResponse {
    success: boolean;
    sessionId?: string;
    reply?: string;
    edits?: ChatResponseEdit[];
    error?: string;
    contextUsed?: string[];
    merkleTree?: MerkleTreeJSON;
}

export interface MerkleTreeJSON {
    hash: string;
    nodeType: 'File' | 'Directory';
    path: string;
    size: number;
    modifiedAt: number;
    createdAt: number;
    children?: MerkleTreeJSON[];
    isLeaf: boolean;
}

export interface ChatSession {
    sessionId: string;
    title: string;
    messageCount: number;
    createdAt: number;
    updatedAt: number;
}

export interface ChatMessage {
    messageId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    metadata?: any;
    createdAt: number;
}

export interface StreamEvent {
    type: 'start' | 'response' | 'complete' | 'error';
    message?: string;
    data?: ChatResponse;
}

export const BackendChatService = Symbol('BackendChatService');

export interface BackendChatService {
    readonly isAvailable: boolean;
    readonly currentProjectId: string | undefined;
    readonly onAvailabilityChanged: Event<boolean>;
    readonly onStreamEvent: Event<StreamEvent>;

    initialize(backendUrl: string, authToken: string): void;
    sendMessage(request: ChatRequest): Promise<ChatResponse>;
    sendMessageStream(request: ChatRequest): Promise<void>;
    getSessions(projectId: string): Promise<ChatSession[]>;
    getSessionHistory(sessionId: string): Promise<ChatMessage[]>;
    deleteSession(sessionId: string): Promise<void>;
}

@injectable()
export class BackendChatServiceImpl implements BackendChatService {

    @inject(ModelSelectorService)
    protected readonly modelSelector: ModelSelectorService;

    @inject(LocalIngestionService)
    protected readonly ingestionService: LocalIngestionService;

    protected _backendUrl: string = '';
    protected _authToken: string = '';
    protected _isAvailable: boolean = false;

    protected readonly onAvailabilityChangedEmitter = new Emitter<boolean>();
    readonly onAvailabilityChanged = this.onAvailabilityChangedEmitter.event;

    protected readonly onStreamEventEmitter = new Emitter<StreamEvent>();
    readonly onStreamEvent = this.onStreamEventEmitter.event;

    get isAvailable(): boolean {
        return this._isAvailable;
    }

    get currentProjectId(): string | undefined {
        return this.ingestionService.currentProject?.projectId;
    }

    @postConstruct()
    protected init(): void {
        // Listen for project changes
        this.ingestionService.onProjectChanged(project => {
            const wasAvailable = this._isAvailable;
            this._isAvailable = project?.ingestionStatus === 'completed';

            if (wasAvailable !== this._isAvailable) {
                this.onAvailabilityChangedEmitter.fire(this._isAvailable);
            }
        });

        // Listen for ingestion completion
        this.ingestionService.onIngestionComplete(() => {
            this._isAvailable = true;
            this.onAvailabilityChangedEmitter.fire(true);
        });
    }

    initialize(backendUrl: string, authToken: string): void {
        this._backendUrl = backendUrl;
        this._authToken = authToken;

        // Initialize model selector
        this.modelSelector.fetchModels(backendUrl);

        // Initialize ingestion service
        this.ingestionService.initialize(backendUrl, authToken);
    }

    async sendMessage(request: ChatRequest): Promise<ChatResponse> {
        if (!this._isAvailable) {
            return {
                success: false,
                error: 'Backend chat not available. Workspace needs to be ingested first.',
            };
        }

        try {
            // Use selected model if not specified
            const model = request.model || this.modelSelector.selectedModelId;

            const response = await fetch(`${this._backendUrl}/api/custom-chat/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._authToken}`,
                },
                body: JSON.stringify({
                    ...request,
                    model,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                return {
                    success: false,
                    error: errorData.error || `Request failed: ${response.statusText}`,
                };
            }

            const data = await response.json();
            return {
                success: true,
                sessionId: data.sessionId,
                reply: data.reply,
                edits: data.edits,
                contextUsed: data.contextUsed,
                merkleTree: data.merkleTree,
            };
        } catch (error) {
            console.error('[BackendChatService] Send error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    async sendMessageStream(request: ChatRequest): Promise<void> {
        if (!this._isAvailable) {
            this.onStreamEventEmitter.fire({
                type: 'error',
                message: 'Backend chat not available. Workspace needs to be ingested first.',
            });
            return;
        }

        try {
            const model = request.model || this.modelSelector.selectedModelId;

            const response = await fetch(`${this._backendUrl}/api/custom-chat/send-stream`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._authToken}`,
                },
                body: JSON.stringify({
                    ...request,
                    model,
                }),
            });

            if (!response.ok) {
                this.onStreamEventEmitter.fire({
                    type: 'error',
                    message: `Request failed: ${response.statusText}`,
                });
                return;
            }

            // Handle SSE stream
            const reader = response.body?.getReader();
            if (!reader) {
                this.onStreamEventEmitter.fire({
                    type: 'error',
                    message: 'No response body',
                });
                return;
            }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });

                // Process complete SSE messages
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            this.onStreamEventEmitter.fire(data as StreamEvent);
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[BackendChatService] Stream error:', error);
            this.onStreamEventEmitter.fire({
                type: 'error',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }

    async getSessions(projectId: string): Promise<ChatSession[]> {
        try {
            const response = await fetch(`${this._backendUrl}/api/custom-chat/sessions/${projectId}`, {
                headers: {
                    'Authorization': `Bearer ${this._authToken}`,
                },
            });

            if (!response.ok) {
                return [];
            }

            const data = await response.json();
            return data.sessions || [];
        } catch (error) {
            console.error('[BackendChatService] Get sessions error:', error);
            return [];
        }
    }

    async getSessionHistory(sessionId: string): Promise<ChatMessage[]> {
        try {
            const response = await fetch(`${this._backendUrl}/api/custom-chat/history/${sessionId}`, {
                headers: {
                    'Authorization': `Bearer ${this._authToken}`,
                },
            });

            if (!response.ok) {
                return [];
            }

            const data = await response.json();
            return data.messages || [];
        } catch (error) {
            console.error('[BackendChatService] Get history error:', error);
            return [];
        }
    }

    async deleteSession(sessionId: string): Promise<void> {
        try {
            await fetch(`${this._backendUrl}/api/custom-chat/sessions/${sessionId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this._authToken}`,
                },
            });
        } catch (error) {
            console.error('[BackendChatService] Delete session error:', error);
        }
    }
}
