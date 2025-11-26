// *****************************************************************************
// Custom Chat Module Exports
// *****************************************************************************

export * from './model-selector-service';
export * from './model-selector';
export * from './local-ingestion-service';
export * from './backend-chat-service';
export * from './merkle-tree-service';
export * from './local-ingestion-contribution';

// Re-export commonly used types
export type {
    MerkleNodeJSON,
    FileChange,
    ChangeSummary,
    MerkleSyncResult as MerkleServiceSyncResult,
    FileInput,
} from './merkle-tree-service';

export type {
    LocalProjectInfo,
    IngestionProgress,
    MerkleSyncResult,
} from './local-ingestion-service';

export type {
    ChatRequest,
    ChatResponse,
    ChatResponseEdit,
    ChatSession,
    ChatMessage,
    StreamEvent,
    MerkleTreeJSON,
} from './backend-chat-service';
