# Plan: Custom AI Chat Flow with Backend Integration

## Overview

This is a **highly modular** plan to:
1. Add model selector dropdown to chat UI
2. Change file tagging syntax from `#` to `/`
3. Integrate with custom backend (`backend/`) for LLM calls
4. Auto-ingest local folders with unique SHA-based project identification

**Key Principle**: Don't modify existing APIs - only add new ones.

---

## Part 1: Unique Project Identification (SHA Hash)

### Problem
When a user opens a local folder, we need to uniquely identify it to:
- Avoid re-ingesting the same folder
- Associate chat history and embeddings with the correct project
- Handle folder renames or moves gracefully

### Solution: Composite SHA256 Hash

Generate a unique hash from:
```
SHA256(user_id + normalized_absolute_path + folder_name)
```

This ensures:
- Same folder opened by different users = different projects
- Same user opening same folder = same project
- Folder moved/renamed = new project (intentional for data integrity)

### Implementation

#### 1.1 New Table: `local_projects`

**File:** `backend/src/database/schema.ts` (add new table, don't modify existing)

```sql
CREATE TABLE IF NOT EXISTS local_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL UNIQUE,      -- UUID for internal use
  user_id TEXT NOT NULL,
  local_hash TEXT NOT NULL UNIQUE,       -- SHA256 composite hash
  folder_name TEXT NOT NULL,
  folder_path TEXT NOT NULL,             -- Absolute path (for display only)
  ingestion_status TEXT DEFAULT 'pending', -- pending, processing, completed, failed
  total_files INTEGER DEFAULT 0,
  processed_files INTEGER DEFAULT 0,
  total_chunks INTEGER DEFAULT 0,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_ingested_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_projects_hash ON local_projects(local_hash);
CREATE INDEX IF NOT EXISTS idx_local_projects_user ON local_projects(user_id);
```

#### 1.2 Hash Generation Utility

**New File:** `backend/src/utils/project-hash.ts`

```typescript
import * as crypto from 'crypto';
import * as path from 'path';

/**
 * Generate unique hash for local project identification
 */
export function generateLocalProjectHash(
  userId: string,
  absoluteFolderPath: string,
  folderName: string
): string {
  // Normalize path (handle Windows/Unix differences)
  const normalizedPath = path.normalize(absoluteFolderPath)
    .toLowerCase()
    .replace(/\\/g, '/');

  // Create composite string
  const composite = `${userId}:${normalizedPath}:${folderName}`;

  // Generate SHA256 hash
  return crypto
    .createHash('sha256')
    .update(composite)
    .digest('hex');
}

/**
 * Generate short hash for display (first 12 chars)
 */
export function getShortHash(fullHash: string): string {
  return fullHash.substring(0, 12);
}
```

#### 1.3 Frontend Hash Generation (for checking before sending files)

**New File:** `packages/ai-chat/src/browser/utils/project-hash.ts`

```typescript
/**
 * Generate SHA256 hash in browser using Web Crypto API
 */
export async function generateLocalProjectHash(
  userId: string,
  absoluteFolderPath: string,
  folderName: string
): Promise<string> {
  const normalizedPath = absoluteFolderPath
    .toLowerCase()
    .replace(/\\/g, '/');

  const composite = `${userId}:${normalizedPath}:${folderName}`;

  const encoder = new TextEncoder();
  const data = encoder.encode(composite);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));

  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
```

---

## Part 2: Backend API Endpoints (New Routes Only)

### 2.1 Local Project Routes

**New File:** `backend/src/routes/localProjects.ts`

```typescript
import { Router, Response } from 'express';
import { DatabaseSchema } from '../database/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { generateLocalProjectHash } from '../utils/project-hash';
import { v4 as uuidv4 } from 'uuid';

export function createLocalProjectRoutes(db: DatabaseSchema): Router {
  const router = Router();
  router.use(requireAuth);

  /**
   * POST /api/local-projects/check
   * Check if local project exists by hash
   */
  router.post('/check', async (req: AuthRequest, res: Response) => {
    const { folderPath, folderName } = req.body;
    const userId = req.auth?.userId;

    if (!userId || !folderPath || !folderName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const localHash = generateLocalProjectHash(userId, folderPath, folderName);

    const existing = db.getDb().prepare(`
      SELECT project_id, ingestion_status, total_files, processed_files
      FROM local_projects WHERE local_hash = ?
    `).get(localHash);

    if (existing) {
      return res.json({
        exists: true,
        projectId: existing.project_id,
        status: existing.ingestion_status,
        progress: {
          total: existing.total_files,
          processed: existing.processed_files,
        },
      });
    }

    res.json({ exists: false, localHash });
  });

  /**
   * POST /api/local-projects/create
   * Create new local project entry
   */
  router.post('/create', async (req: AuthRequest, res: Response) => {
    const { folderPath, folderName, localHash } = req.body;
    const userId = req.auth?.userId;

    if (!userId || !folderPath || !folderName || !localHash) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const now = Date.now();
    const projectId = uuidv4();

    try {
      db.transaction(() => {
        // Create main project entry
        db.getDb().prepare(`
          INSERT INTO projects (
            project_id, user_id, project_name, is_github_repo,
            created_at, updated_at
          ) VALUES (?, ?, ?, 0, ?, ?)
        `).run(projectId, userId, folderName, now, now);

        // Create local project tracking entry
        db.getDb().prepare(`
          INSERT INTO local_projects (
            project_id, user_id, local_hash, folder_name, folder_path,
            ingestion_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(projectId, userId, localHash, folderName, folderPath, now, now);
      });

      res.json({
        success: true,
        projectId,
        localHash,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/local-projects/:projectId/status
   * Get ingestion status
   */
  router.get('/:projectId/status', async (req: AuthRequest, res: Response) => {
    const { projectId } = req.params;
    const userId = req.auth?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const project = db.getDb().prepare(`
      SELECT * FROM local_projects WHERE project_id = ? AND user_id = ?
    `).get(projectId, userId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json(project);
  });

  return router;
}
```

### 2.2 Local Ingestion Routes

**New File:** `backend/src/routes/localIngest.ts`

```typescript
import { Router, Response } from 'express';
import { DatabaseSchema } from '../database/schema';
import { FileIngestionService } from '../services/FileIngestionService';
import { requireAuth, AuthRequest } from '../middleware/auth';

export interface FileUpload {
  path: string;
  content: string;
  size: number;
}

export function createLocalIngestRoutes(
  db: DatabaseSchema,
  fileIngestionService: FileIngestionService
): Router {
  const router = Router();
  router.use(requireAuth);

  /**
   * POST /api/local-ingest/:projectId/files
   * Receive files from frontend for ingestion
   * Accepts batched file uploads
   */
  router.post('/:projectId/files', async (req: AuthRequest, res: Response) => {
    const { projectId } = req.params;
    const { files, batchIndex, totalBatches } = req.body as {
      files: FileUpload[];
      batchIndex: number;
      totalBatches: number;
    };
    const userId = req.auth?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify ownership
    const localProject = db.getDb().prepare(`
      SELECT * FROM local_projects WHERE project_id = ? AND user_id = ?
    `).get(projectId, userId);

    if (!localProject) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      // Update status to processing if first batch
      if (batchIndex === 0) {
        db.getDb().prepare(`
          UPDATE local_projects
          SET ingestion_status = 'processing', updated_at = ?
          WHERE project_id = ?
        `).run(Date.now(), projectId);
      }

      // Process this batch
      await fileIngestionService.ingestFileBatch(projectId, files);

      // Update progress
      const currentProgress = db.getDb().prepare(`
        SELECT processed_files, total_files FROM local_projects WHERE project_id = ?
      `).get(projectId) as { processed_files: number; total_files: number };

      const newProcessed = currentProgress.processed_files + files.length;

      db.getDb().prepare(`
        UPDATE local_projects
        SET processed_files = ?, updated_at = ?
        WHERE project_id = ?
      `).run(newProcessed, Date.now(), projectId);

      // Mark complete if last batch
      if (batchIndex === totalBatches - 1) {
        db.getDb().prepare(`
          UPDATE local_projects
          SET ingestion_status = 'completed', last_ingested_at = ?, updated_at = ?
          WHERE project_id = ?
        `).run(Date.now(), Date.now(), projectId);
      }

      res.json({
        success: true,
        batchIndex,
        filesProcessed: files.length,
        totalProcessed: newProcessed,
      });
    } catch (error: any) {
      db.getDb().prepare(`
        UPDATE local_projects
        SET ingestion_status = 'failed', error_message = ?, updated_at = ?
        WHERE project_id = ?
      `).run(error.message, Date.now(), projectId);

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/local-ingest/:projectId/init
   * Initialize ingestion with file count
   */
  router.post('/:projectId/init', async (req: AuthRequest, res: Response) => {
    const { projectId } = req.params;
    const { totalFiles } = req.body;
    const userId = req.auth?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    db.getDb().prepare(`
      UPDATE local_projects
      SET total_files = ?, processed_files = 0, ingestion_status = 'pending', updated_at = ?
      WHERE project_id = ? AND user_id = ?
    `).run(totalFiles, Date.now(), projectId, userId);

    res.json({ success: true, totalFiles });
  });

  return router;
}
```

### 2.3 Custom Chat Routes (Using Backend LLM)

**New File:** `backend/src/routes/customChat.ts`

```typescript
import { Router, Response } from 'express';
import { DatabaseSchema } from '../database/schema';
import { AICodeChatService } from '../services/AICodeChatService';
import { requireAuth, AuthRequest } from '../middleware/auth';

export interface CustomChatRequest {
  projectId: string;
  sessionId?: string;
  message: string;
  model?: string;
  contextFiles?: Array<{
    path: string;
    content: string;
  }>;
}

export function createCustomChatRoutes(
  db: DatabaseSchema,
  aiChatService: AICodeChatService
): Router {
  const router = Router();
  router.use(requireAuth);

  /**
   * POST /api/custom-chat/send
   * Send chat message to backend LLM
   */
  router.post('/send', async (req: AuthRequest, res: Response) => {
    const request = req.body as CustomChatRequest;
    const userId = req.auth?.userId;

    if (!userId || !request.projectId || !request.message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify project ownership
    if (!db.userOwnsProject(userId, request.projectId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      // Build file context from provided files
      const fileContext = request.contextFiles?.[0] ? {
        filePath: request.contextFiles[0].path,
        content: request.contextFiles[0].content,
      } : undefined;

      const response = await aiChatService.chatEdit({
        projectId: request.projectId,
        sessionId: request.sessionId,
        message: request.message,
        fileContext,
      });

      res.json(response);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/custom-chat/models
   * Get available models
   */
  router.get('/models', async (req: AuthRequest, res: Response) => {
    // Return configured models
    const models = [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', vendor: 'Google', default: true },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', vendor: 'Google' },
      { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash', vendor: 'Google' },
    ];

    res.json({ models });
  });

  return router;
}
```

### 2.4 Register New Routes in Server

**File:** `backend/src/server.ts` (add after existing route registrations)

```typescript
// Add imports at top
import { createLocalProjectRoutes } from './routes/localProjects';
import { createLocalIngestRoutes } from './routes/localIngest';
import { createCustomChatRoutes } from './routes/customChat';

// Add after line 311 (after job stream routes)
app.use('/api/local-projects', createLocalProjectRoutes(db));
app.use('/api/local-ingest', createLocalIngestRoutes(db, fileIngestionService));
if (aiCodeChatService) {
  app.use('/api/custom-chat', createCustomChatRoutes(db, aiCodeChatService));
}
log.info('✓ Local project routes registered');
```

---

## Part 3: Symbol Leader Change (# → /)

### Files to Modify

#### 3.1 Change Constants

**File:** `packages/ai-chat/src/common/parsed-chat-request.ts`

```typescript
// Line 26-29: Change from
export const chatVariableLeader = '#';
export const chatSubcommandLeader = '/';

// To:
export const chatVariableLeader = '/';      // /file:path/to/file.ts
export const chatSubcommandLeader = '!';    // !command args (or remove entirely)
```

#### 3.2 Update Regex Pattern

**File:** `packages/ai-chat/src/common/chat-request-parser.ts`

```typescript
// Line 45-46: Change from
const variableReg = /^#([\w_\-]+)(?::([\w_\-_\/\\.:]+))?(?=(\s|$|\b))/i;
const commandReg = /^\/([\w_\-]+)(?:\s+(.+?))?(?=\s*$)/;

// To:
const variableReg = /^\/([\w_\-]+)(?::([\w_\-_\/\\.:]+))?(?=(\s|$|\b))/i;
// Remove or change commandReg if needed
```

#### 3.3 Update Parser Logic

**File:** `packages/ai-chat/src/common/chat-request-parser.ts`

In `parseParts()` method (around line 119), update the order of checks:
```typescript
// Check for '/' as variable leader (file tagging)
if (char === chatVariableLeader) {
  const variablePart = this.tryToParseVariable(/*...*/);
  // ...
}
// Remove or relocate command parsing
```

#### 3.4 Update UI Hints

**File:** `packages/ai-chat-ui/src/browser/chat-input-widget.tsx`

Update any placeholder text that mentions `#`:
```typescript
// Find and replace hints like "Use #file:path" with "Use /file:path"
```

---

## Part 4: Model Selector Dropdown

### Architecture

Create modular components:
1. `ModelSelectorService` - Manages available models and selection
2. `ModelSelector` - React component for UI
3. Integration with `ChatInputWidget`

### 4.1 Model Selector Service

**New File:** `packages/ai-chat/src/browser/model-selector-service.ts`

```typescript
import { injectable, inject } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';

export interface AIModel {
  id: string;
  name: string;
  vendor: string;
  isDefault?: boolean;
}

export const ModelSelectorService = Symbol('ModelSelectorService');

export interface ModelSelectorService {
  readonly models: AIModel[];
  readonly selectedModel: AIModel | undefined;
  readonly onModelChanged: Event<AIModel>;

  setSelectedModel(modelId: string): void;
  fetchModels(): Promise<void>;
}

@injectable()
export class ModelSelectorServiceImpl implements ModelSelectorService {
  protected _models: AIModel[] = [];
  protected _selectedModel: AIModel | undefined;
  protected readonly onModelChangedEmitter = new Emitter<AIModel>();

  readonly onModelChanged = this.onModelChangedEmitter.event;

  protected readonly backendUrl: string;

  constructor() {
    this.backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
  }

  get models(): AIModel[] {
    return this._models;
  }

  get selectedModel(): AIModel | undefined {
    return this._selectedModel;
  }

  async fetchModels(): Promise<void> {
    try {
      const response = await fetch(`${this.backendUrl}/api/custom-chat/models`);
      const data = await response.json();
      this._models = data.models;

      // Set default model
      this._selectedModel = this._models.find(m => m.isDefault) || this._models[0];
    } catch (error) {
      console.error('Failed to fetch models:', error);
      // Fallback to defaults
      this._models = [
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', vendor: 'Google', isDefault: true },
      ];
      this._selectedModel = this._models[0];
    }
  }

  setSelectedModel(modelId: string): void {
    const model = this._models.find(m => m.id === modelId);
    if (model && model !== this._selectedModel) {
      this._selectedModel = model;
      this.onModelChangedEmitter.fire(model);
    }
  }
}
```

### 4.2 Model Selector Component

**New File:** `packages/ai-chat-ui/src/browser/components/model-selector.tsx`

```typescript
import * as React from '@theia/core/shared/react';

export interface ModelOption {
  id: string;
  name: string;
  vendor: string;
}

export interface ModelSelectorProps {
  models: ModelOption[];
  selectedModelId?: string;
  onModelChange: (modelId: string) => void;
  disabled?: boolean;
  className?: string;
}

export const ModelSelector: React.FC<ModelSelectorProps> = React.memo(({
  models,
  selectedModelId,
  onModelChange,
  disabled = false,
  className = '',
}) => {
  const selectedModel = React.useMemo(
    () => models.find(m => m.id === selectedModelId) || models[0],
    [models, selectedModelId]
  );

  return (
    <div className={`theia-ChatInput-ModelSelector ${className}`}>
      <select
        value={selectedModel?.id || ''}
        onChange={e => onModelChange(e.target.value)}
        disabled={disabled || models.length === 0}
        title={selectedModel ? `${selectedModel.name} (${selectedModel.vendor})` : 'Select model'}
      >
        {models.map(model => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
      <span className="vendor-badge">{selectedModel?.vendor}</span>
    </div>
  );
});

ModelSelector.displayName = 'ModelSelector';
```

### 4.3 CSS for Model Selector

**File:** `packages/ai-chat-ui/src/browser/style/index.css` (add)

```css
/* Model Selector */
.theia-ChatInput-ModelSelector {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
}

.theia-ChatInput-ModelSelector select {
  background: var(--theia-input-background);
  color: var(--theia-input-foreground);
  border: 1px solid var(--theia-input-border);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  cursor: pointer;
  outline: none;
}

.theia-ChatInput-ModelSelector select:hover {
  border-color: var(--theia-focusBorder);
}

.theia-ChatInput-ModelSelector select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.theia-ChatInput-ModelSelector .vendor-badge {
  font-size: 9px;
  padding: 1px 4px;
  background: var(--theia-badge-background);
  color: var(--theia-badge-foreground);
  border-radius: 3px;
}
```

### 4.4 Integrate into ChatInputWidget

**File:** `packages/ai-chat-ui/src/browser/chat-input-widget.tsx`

Add to imports:
```typescript
import { ModelSelector } from './components/model-selector';
import { ModelSelectorService } from '@theia/ai-chat/lib/browser/model-selector-service';
```

Add injection:
```typescript
@inject(ModelSelectorService)
protected readonly modelSelectorService: ModelSelectorService;
```

Add to `ChatInputOptions` render (around line 1147):
```typescript
{/* Add after mode selector */}
<ModelSelector
  models={modelSelectorService.models}
  selectedModelId={modelSelectorService.selectedModel?.id}
  onModelChange={id => modelSelectorService.setSelectedModel(id)}
  disabled={!isEnabled}
/>
```

---

## Part 5: Frontend Local Ingestion Service

### 5.1 Local Ingestion Service

**New File:** `packages/ai-chat/src/browser/local-ingestion-service.ts`

```typescript
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { URI } from '@theia/core';
import { Emitter, Event } from '@theia/core';
import { generateLocalProjectHash } from './utils/project-hash';

export interface IngestionProgress {
  projectId: string;
  status: 'checking' | 'creating' | 'uploading' | 'processing' | 'completed' | 'error';
  totalFiles: number;
  processedFiles: number;
  currentBatch: number;
  totalBatches: number;
  error?: string;
}

export const LocalIngestionService = Symbol('LocalIngestionService');

export interface LocalIngestionService {
  readonly onProgressChanged: Event<IngestionProgress>;
  readonly currentProjectId: string | undefined;

  checkAndIngestWorkspace(): Promise<void>;
  getProgress(): IngestionProgress | undefined;
}

@injectable()
export class LocalIngestionServiceImpl implements LocalIngestionService {
  @inject(WorkspaceService)
  protected readonly workspaceService: WorkspaceService;

  @inject(FileService)
  protected readonly fileService: FileService;

  protected readonly onProgressChangedEmitter = new Emitter<IngestionProgress>();
  readonly onProgressChanged = this.onProgressChangedEmitter.event;

  protected _progress: IngestionProgress | undefined;
  protected _currentProjectId: string | undefined;
  protected processedWorkspaces = new Set<string>();

  protected readonly backendUrl = 'http://localhost:3000';
  protected readonly BATCH_SIZE = 30;

  // File filtering
  protected readonly IGNORE_DIRS = [
    '.git', 'node_modules', '.next', 'dist', 'build', 'out',
    'coverage', '.cache', 'vendor', 'target', '__pycache__',
    '.venv', 'venv', '.idea', '.vscode',
  ];

  protected readonly CODE_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c',
    '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala',
    '.html', '.css', '.scss', '.json', '.yaml', '.yml', '.md',
    '.sh', '.sql', '.xml', '.vue', '.svelte',
  ]);

  get currentProjectId(): string | undefined {
    return this._currentProjectId;
  }

  getProgress(): IngestionProgress | undefined {
    return this._progress;
  }

  @postConstruct()
  protected init(): void {
    // Listen for workspace changes
    this.workspaceService.onWorkspaceChanged(() => {
      this.checkAndIngestWorkspace();
    });
  }

  async checkAndIngestWorkspace(): Promise<void> {
    const roots = await this.workspaceService.roots;
    if (roots.length === 0) return;

    const workspaceRoot = roots[0].resource;
    const workspaceKey = workspaceRoot.toString();

    // Skip if already processed in this session
    if (this.processedWorkspaces.has(workspaceKey)) {
      return;
    }

    const folderName = workspaceRoot.path.base;
    const folderPath = workspaceRoot.path.toString();

    // Get user ID from auth (implement based on your auth system)
    const userId = await this.getCurrentUserId();
    if (!userId) return;

    // Generate hash
    const localHash = await generateLocalProjectHash(userId, folderPath, folderName);

    this.updateProgress({
      projectId: '',
      status: 'checking',
      totalFiles: 0,
      processedFiles: 0,
      currentBatch: 0,
      totalBatches: 0,
    });

    try {
      // Check if project exists
      const checkResponse = await fetch(`${this.backendUrl}/api/local-projects/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath, folderName }),
      });

      const checkResult = await checkResponse.json();

      if (checkResult.exists) {
        // Project already ingested
        this._currentProjectId = checkResult.projectId;
        this.processedWorkspaces.add(workspaceKey);
        this.updateProgress({
          projectId: checkResult.projectId,
          status: 'completed',
          totalFiles: checkResult.progress.total,
          processedFiles: checkResult.progress.processed,
          currentBatch: 0,
          totalBatches: 0,
        });
        return;
      }

      // Create new project
      this.updateProgress({ ...this._progress!, status: 'creating' });

      const createResponse = await fetch(`${this.backendUrl}/api/local-projects/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath, folderName, localHash }),
      });

      const createResult = await createResponse.json();
      this._currentProjectId = createResult.projectId;

      // Collect files
      const files = await this.collectFiles(workspaceRoot);

      if (files.length === 0) {
        this.updateProgress({
          projectId: createResult.projectId,
          status: 'completed',
          totalFiles: 0,
          processedFiles: 0,
          currentBatch: 0,
          totalBatches: 0,
        });
        this.processedWorkspaces.add(workspaceKey);
        return;
      }

      // Initialize ingestion
      await fetch(`${this.backendUrl}/api/local-ingest/${createResult.projectId}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalFiles: files.length }),
      });

      // Upload in batches
      const totalBatches = Math.ceil(files.length / this.BATCH_SIZE);

      this.updateProgress({
        projectId: createResult.projectId,
        status: 'uploading',
        totalFiles: files.length,
        processedFiles: 0,
        currentBatch: 0,
        totalBatches,
      });

      for (let i = 0; i < files.length; i += this.BATCH_SIZE) {
        const batch = files.slice(i, i + this.BATCH_SIZE);
        const batchIndex = Math.floor(i / this.BATCH_SIZE);

        await fetch(`${this.backendUrl}/api/local-ingest/${createResult.projectId}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: batch,
            batchIndex,
            totalBatches,
          }),
        });

        this.updateProgress({
          projectId: createResult.projectId,
          status: 'uploading',
          totalFiles: files.length,
          processedFiles: Math.min(i + this.BATCH_SIZE, files.length),
          currentBatch: batchIndex + 1,
          totalBatches,
        });
      }

      this.updateProgress({
        projectId: createResult.projectId,
        status: 'completed',
        totalFiles: files.length,
        processedFiles: files.length,
        currentBatch: totalBatches,
        totalBatches,
      });

      this.processedWorkspaces.add(workspaceKey);

    } catch (error: any) {
      this.updateProgress({
        projectId: this._currentProjectId || '',
        status: 'error',
        totalFiles: 0,
        processedFiles: 0,
        currentBatch: 0,
        totalBatches: 0,
        error: error.message,
      });
    }
  }

  protected async collectFiles(
    rootUri: URI
  ): Promise<Array<{ path: string; content: string; size: number }>> {
    const files: Array<{ path: string; content: string; size: number }> = [];
    await this.traverseDirectory(rootUri, rootUri, files);
    return files;
  }

  protected async traverseDirectory(
    currentUri: URI,
    rootUri: URI,
    files: Array<{ path: string; content: string; size: number }>
  ): Promise<void> {
    try {
      const stat = await this.fileService.resolve(currentUri);

      if (!stat || !stat.isDirectory || !stat.children) {
        return;
      }

      for (const child of stat.children) {
        const name = child.resource.path.base;

        if (child.isDirectory) {
          if (!this.IGNORE_DIRS.includes(name)) {
            await this.traverseDirectory(child.resource, rootUri, files);
          }
        } else {
          const ext = '.' + name.split('.').pop()?.toLowerCase();
          if (this.CODE_EXTENSIONS.has(ext)) {
            try {
              const content = await this.fileService.read(child.resource);
              const relativePath = rootUri.relative(child.resource)?.toString() || name;

              // Skip files > 1MB
              if (content.value.length < 1024 * 1024) {
                files.push({
                  path: relativePath,
                  content: content.value,
                  size: content.value.length,
                });
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  protected updateProgress(progress: IngestionProgress): void {
    this._progress = progress;
    this.onProgressChangedEmitter.fire(progress);
  }

  protected async getCurrentUserId(): Promise<string | undefined> {
    // Implement based on your auth system
    // Could be from a cookie, local storage, or auth service
    return 'default-user';
  }
}
```

---

## Part 6: Backend Chat Service

### 6.1 Backend Chat Communication

**New File:** `packages/ai-chat/src/browser/backend-chat-service.ts`

```typescript
import { injectable, inject } from '@theia/core/shared/inversify';
import { ModelSelectorService } from './model-selector-service';
import { LocalIngestionService } from './local-ingestion-service';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  message: string;
  contextFiles?: Array<{ path: string; content: string }>;
  sessionId?: string;
}

export interface ChatResponse {
  sessionId: string;
  messageId: string;
  explanation: string;
  edits?: Array<{
    file: string;
    action: string;
    oldCode?: string;
    newCode?: string;
    startLine?: number;
    endLine?: number;
  }>;
}

export const BackendChatService = Symbol('BackendChatService');

export interface BackendChatService {
  sendMessage(request: ChatRequest): Promise<ChatResponse>;
  getHistory(sessionId: string): Promise<ChatMessage[]>;
}

@injectable()
export class BackendChatServiceImpl implements BackendChatService {
  @inject(ModelSelectorService)
  protected readonly modelService: ModelSelectorService;

  @inject(LocalIngestionService)
  protected readonly ingestionService: LocalIngestionService;

  protected readonly backendUrl = 'http://localhost:3000';

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    const projectId = this.ingestionService.currentProjectId;

    if (!projectId) {
      throw new Error('No project loaded. Open a folder first.');
    }

    const response = await fetch(`${this.backendUrl}/api/custom-chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        sessionId: request.sessionId,
        message: request.message,
        model: this.modelService.selectedModel?.id,
        contextFiles: request.contextFiles,
      }),
    });

    if (!response.ok) {
      throw new Error(`Chat failed: ${response.statusText}`);
    }

    return response.json();
  }

  async getHistory(sessionId: string): Promise<ChatMessage[]> {
    const response = await fetch(
      `${this.backendUrl}/api/chat/${sessionId}/history`
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return data.messages || [];
  }
}
```

---

## Part 7: Module Registration

### 7.1 Frontend Module

**File:** `packages/ai-chat/src/browser/ai-chat-frontend-module.ts` (add bindings)

```typescript
// Add imports
import { ModelSelectorService, ModelSelectorServiceImpl } from './model-selector-service';
import { LocalIngestionService, LocalIngestionServiceImpl } from './local-ingestion-service';
import { BackendChatService, BackendChatServiceImpl } from './backend-chat-service';

// Add in bind section
bind(ModelSelectorService).to(ModelSelectorServiceImpl).inSingletonScope();
bind(LocalIngestionService).to(LocalIngestionServiceImpl).inSingletonScope();
bind(BackendChatService).to(BackendChatServiceImpl).inSingletonScope();

// Initialize model service on startup
bind(FrontendApplicationContribution).toDynamicValue(ctx => ({
  onStart: async () => {
    const modelService = ctx.container.get<ModelSelectorService>(ModelSelectorService);
    await modelService.fetchModels();

    const ingestionService = ctx.container.get<LocalIngestionService>(LocalIngestionService);
    await ingestionService.checkAndIngestWorkspace();
  }
})).inSingletonScope();
```

---

## Implementation Order

### Phase 1: Foundation (Backend)
1. Add `local_projects` table to schema
2. Create `project-hash.ts` utility
3. Create `localProjects.ts` routes
4. Create `localIngest.ts` routes
5. Register routes in `server.ts`

### Phase 2: Symbol Change
1. Update `parsed-chat-request.ts` constants
2. Update `chat-request-parser.ts` regex
3. Update UI placeholder text

### Phase 3: Model Selector
1. Create `model-selector-service.ts`
2. Create `model-selector.tsx` component
3. Add CSS styles
4. Integrate into `chat-input-widget.tsx`

### Phase 4: Ingestion Flow
1. Create frontend `project-hash.ts`
2. Create `local-ingestion-service.ts`
3. Add initialization in module
4. Test with real folder

### Phase 5: Chat Integration
1. Create `customChat.ts` routes
2. Create `backend-chat-service.ts`
3. Wire up chat widget to use backend

---

## File Summary

### New Backend Files:
```
backend/src/
├── utils/
│   └── project-hash.ts              # Hash generation utility
├── routes/
│   ├── localProjects.ts             # Local project management
│   ├── localIngest.ts               # File ingestion endpoints
│   └── customChat.ts                # Custom chat endpoints
└── database/
    └── schema.ts                    # (modify: add local_projects table)
```

### New Frontend Files:
```
packages/ai-chat/src/browser/
├── utils/
│   └── project-hash.ts              # Browser hash generation
├── model-selector-service.ts        # Model management
├── local-ingestion-service.ts       # Workspace ingestion
└── backend-chat-service.ts          # Chat communication

packages/ai-chat-ui/src/browser/
├── components/
│   └── model-selector.tsx           # Model dropdown component
└── style/
    └── index.css                    # (modify: add model selector styles)
```

### Modified Files:
```
packages/ai-chat/src/common/
├── parsed-chat-request.ts           # Symbol leader change
└── chat-request-parser.ts           # Regex pattern change

packages/ai-chat-ui/src/browser/
└── chat-input-widget.tsx            # Add model selector

backend/src/
└── server.ts                        # Register new routes
```
