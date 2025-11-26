// *****************************************************************************
// Local Ingestion Service
// Handles automatic ingestion of local folders when opened in the workspace
// *****************************************************************************

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import { MerkleTreeService, MerkleNodeJSON } from './merkle-tree-service';

export interface LocalProjectInfo {
    projectId: string;
    localHash: string;
    folderName: string;
    folderPath: string;
    ingestionStatus: 'pending' | 'processing' | 'completed' | 'failed';
    totalFiles: number;
    processedFiles: number;
    totalChunks: number;
    error?: string;
}

export interface IngestionProgress {
    projectId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: {
        total: number;
        processed: number;
        chunks: number;
        percent: number;
    };
    error?: string;
}

export const LocalIngestionService = Symbol('LocalIngestionService');

export interface MerkleSyncResult {
    success: boolean;
    changes?: Array<{ changeType: string; path: string }>;
    summary?: { added: number; modified: number; deleted: number; total: number };
    filesProcessed?: number;
    filesDeleted?: number;
    error?: string;
}

export interface LocalIngestionService {
    readonly currentProject: LocalProjectInfo | undefined;
    readonly currentMerkleTree: MerkleNodeJSON | undefined;
    readonly onProjectChanged: Event<LocalProjectInfo | undefined>;
    readonly onIngestionProgress: Event<IngestionProgress>;
    readonly onIngestionComplete: Event<LocalProjectInfo>;
    readonly onIngestionError: Event<{ projectId: string; error: string }>;

    initialize(backendUrl: string, authToken: string): void;
    checkAndIngestWorkspace(): Promise<LocalProjectInfo | undefined>;
    getProjectStatus(projectId: string): Promise<LocalProjectInfo | undefined>;
    ingestFolder(folderUri: URI): Promise<LocalProjectInfo | undefined>;
    retryIngestion(projectId: string): Promise<void>;
    getMerkleTree(projectId: string): Promise<MerkleNodeJSON | undefined>;
    updateMerkleTree(projectId: string, merkleTree: MerkleNodeJSON): Promise<void>;
    /**
     * Sync local files with backend using Merkle tree comparison
     * Only sends changed files for re-ingestion
     */
    syncWithMerkle(projectId: string, folderUri: URI): Promise<MerkleSyncResult>;
}

// File extensions to include for ingestion
const CODE_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.sh',
    '.sql', '.html', '.css', '.scss', '.json', '.yaml', '.yml', '.xml', '.md', '.txt'
]);

// Directories to ignore
const IGNORE_DIRS = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
    '.cache', 'vendor', 'target', '__pycache__', '.pytest_cache', '.venv', 'venv'
]);

// Extensions to ignore
const IGNORE_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.ogg',
    '.zip', '.tar', '.gz', '.rar', '.7z', '.pdf', '.doc', '.docx',
    '.exe', '.dll', '.so', '.dylib', '.lock', '.log', '.min.js', '.min.css', '.map'
]);

@injectable()
export class LocalIngestionServiceImpl implements LocalIngestionService {

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(MerkleTreeService)
    protected readonly merkleTreeService: MerkleTreeService;

    protected _currentProject: LocalProjectInfo | undefined;
    protected _currentMerkleTree: MerkleNodeJSON | undefined;
    protected _backendUrl: string = '';
    protected _authToken: string = '';
    protected _initialized: boolean = false;

    protected readonly onProjectChangedEmitter = new Emitter<LocalProjectInfo | undefined>();
    readonly onProjectChanged = this.onProjectChangedEmitter.event;

    protected readonly onIngestionProgressEmitter = new Emitter<IngestionProgress>();
    readonly onIngestionProgress = this.onIngestionProgressEmitter.event;

    protected readonly onIngestionCompleteEmitter = new Emitter<LocalProjectInfo>();
    readonly onIngestionComplete = this.onIngestionCompleteEmitter.event;

    protected readonly onIngestionErrorEmitter = new Emitter<{ projectId: string; error: string }>();
    readonly onIngestionError = this.onIngestionErrorEmitter.event;

    get currentProject(): LocalProjectInfo | undefined {
        return this._currentProject;
    }

    get currentMerkleTree(): MerkleNodeJSON | undefined {
        return this._currentMerkleTree;
    }

    @postConstruct()
    protected init(): void {
        console.log('[LocalIngestionService] 🚀 Service initialized (postConstruct)');
        // Listen for workspace changes
        this.workspaceService.onWorkspaceChanged(() => {
            console.log('[LocalIngestionService] 📁 Workspace changed event received');
            if (this._initialized) {
                console.log('[LocalIngestionService] 📁 Service is initialized, checking workspace...');
                this.checkAndIngestWorkspace();
            } else {
                console.log('[LocalIngestionService] ⚠️ Service not yet initialized with backend URL');
            }
        });
    }

    initialize(backendUrl: string, authToken: string): void {
        console.log('[LocalIngestionService] 🔧 initialize() called');
        console.log(`[LocalIngestionService] 🔧 Backend URL: ${backendUrl}`);
        console.log(`[LocalIngestionService] 🔧 Auth token present: ${!!authToken}`);

        this._backendUrl = backendUrl;
        this._authToken = authToken;
        this._initialized = true;

        console.log('[LocalIngestionService] ✅ Service initialized, now checking workspace...');
        // Check current workspace
        this.checkAndIngestWorkspace();
    }

    async checkAndIngestWorkspace(): Promise<LocalProjectInfo | undefined> {
        console.log('[LocalIngestionService] 📂 checkAndIngestWorkspace() called');

        const roots = this.workspaceService.tryGetRoots();
        console.log(`[LocalIngestionService] 📂 Found ${roots.length} workspace roots`);

        if (roots.length === 0) {
            console.log('[LocalIngestionService] ⚠️ No workspace roots found');
            this._currentProject = undefined;
            this.onProjectChangedEmitter.fire(undefined);
            return undefined;
        }

        // Use the first root folder
        const rootUri = new URI(roots[0].resource.toString());
        console.log(`[LocalIngestionService] 📂 Using first root: ${rootUri.path.toString()}`);
        return this.ingestFolder(rootUri);
    }

    async ingestFolder(folderUri: URI): Promise<LocalProjectInfo | undefined> {
        console.log('[LocalIngestionService] ========================================');
        console.log('[LocalIngestionService] 🗂️ ingestFolder() START');
        console.log(`[LocalIngestionService] 🗂️ Folder URI: ${folderUri.toString()}`);

        if (!this._initialized) {
            console.warn('[LocalIngestionService] ❌ Service not initialized - cannot proceed');
            return undefined;
        }

        try {
            const folderPath = folderUri.path.toString();
            const folderName = folderUri.path.base;

            console.log(`[LocalIngestionService] 📁 Folder path: ${folderPath}`);
            console.log(`[LocalIngestionService] 📁 Folder name: ${folderName}`);

            // Step 1: Check if project exists on server
            console.log('[LocalIngestionService] 🔍 Step 1: Checking if project exists on server...');
            const existingProject = await this.checkProjectExists(folderPath, folderName);

            if (existingProject) {
                console.log('[LocalIngestionService] ✅ Project EXISTS on server!');
                console.log(`[LocalIngestionService] 📋 Project ID: ${existingProject.projectId}`);
                console.log(`[LocalIngestionService] 📋 Ingestion Status: ${existingProject.ingestionStatus}`);
                console.log(`[LocalIngestionService] 📋 Total Files: ${existingProject.totalFiles}`);
                console.log(`[LocalIngestionService] 📋 Total Chunks: ${existingProject.totalChunks}`);

                this._currentProject = existingProject;
                this.onProjectChangedEmitter.fire(existingProject);

                // Step 2: If project is completed, do Merkle sync to detect local changes
                if (existingProject.ingestionStatus === 'completed') {
                    console.log('[LocalIngestionService] 🔄 Project completed - Starting MERKLE SYNC to detect local changes...');
                    const syncResult = await this.syncWithMerkle(existingProject.projectId, folderUri);

                    if (syncResult.success) {
                        console.log('[LocalIngestionService] ✅ Merkle sync completed successfully!');
                        console.log(`[LocalIngestionService] 📊 Changes detected: ${syncResult.summary?.total || 0}`);
                        console.log(`[LocalIngestionService] 📊 - Added: ${syncResult.summary?.added || 0}`);
                        console.log(`[LocalIngestionService] 📊 - Modified: ${syncResult.summary?.modified || 0}`);
                        console.log(`[LocalIngestionService] 📊 - Deleted: ${syncResult.summary?.deleted || 0}`);
                        console.log(`[LocalIngestionService] 📊 Files processed: ${syncResult.filesProcessed || 0}`);
                        console.log(`[LocalIngestionService] 📊 Files deleted: ${syncResult.filesDeleted || 0}`);
                    } else {
                        console.error('[LocalIngestionService] ❌ Merkle sync failed:', syncResult.error);
                    }
                } else if (existingProject.ingestionStatus === 'processing') {
                    // If ingestion is in progress, poll for status
                    console.log('[LocalIngestionService] ⏳ Ingestion in progress - polling for status...');
                    this.pollIngestionProgress(existingProject.projectId);
                } else if (existingProject.ingestionStatus === 'failed') {
                    console.log('[LocalIngestionService] ❌ Previous ingestion failed - consider retrying');
                } else {
                    console.log(`[LocalIngestionService] ⚠️ Unknown status: ${existingProject.ingestionStatus}`);
                }

                console.log('[LocalIngestionService] 🗂️ ingestFolder() END (existing project)');
                console.log('[LocalIngestionService] ========================================');
                return existingProject;
            }

            // Step 3: Project doesn't exist - create new and do full ingestion
            console.log('[LocalIngestionService] 🆕 Project does NOT exist on server');
            console.log(`[LocalIngestionService] 🆕 Creating new project for folder: ${folderName}`);

            const newProject = await this.createProject(folderPath, folderName);

            if (!newProject) {
                console.error('[LocalIngestionService] ❌ Failed to create project!');
                throw new Error('Failed to create project');
            }

            console.log('[LocalIngestionService] ✅ New project created!');
            console.log(`[LocalIngestionService] 📋 Project ID: ${newProject.projectId}`);
            console.log(`[LocalIngestionService] 📋 Local Hash: ${newProject.localHash}`);

            this._currentProject = newProject;
            this.onProjectChangedEmitter.fire(newProject);

            // Step 4: Start full ingestion for new project
            console.log('[LocalIngestionService] 📤 Starting FULL INGESTION for new project...');
            await this.startIngestion(newProject.projectId, folderUri);

            console.log('[LocalIngestionService] 🗂️ ingestFolder() END (new project)');
            console.log('[LocalIngestionService] ========================================');
            return newProject;
        } catch (error) {
            console.error('[LocalIngestionService] ❌ Error in ingestFolder():', error);
            console.log('[LocalIngestionService] ========================================');
            return undefined;
        }
    }

    protected async checkProjectExists(folderPath: string, folderName: string): Promise<LocalProjectInfo | undefined> {
        console.log('[LocalIngestionService] 🔍 checkProjectExists() called');
        console.log(`[LocalIngestionService] 🔍 Checking: ${folderName} at ${folderPath}`);
        console.log(`[LocalIngestionService] 🔍 API URL: ${this._backendUrl}/api/local-projects/check`);

        try {
            const response = await fetch(`${this._backendUrl}/api/local-projects/check`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._authToken}`,
                },
                body: JSON.stringify({ folderPath, folderName }),
            });

            console.log(`[LocalIngestionService] 🔍 Response status: ${response.status}`);

            if (!response.ok) {
                if (response.status === 404) {
                    console.log('[LocalIngestionService] 🔍 Project NOT found (404)');
                    return undefined;
                }
                console.error(`[LocalIngestionService] ❌ Check failed: ${response.statusText}`);
                throw new Error(`Check failed: ${response.statusText}`);
            }

            const data = await response.json();
            console.log(`[LocalIngestionService] 🔍 Response data:`, JSON.stringify(data, null, 2));

            if (!data.exists) {
                console.log('[LocalIngestionService] 🔍 Project does not exist (exists=false)');
                return undefined;
            }

            console.log('[LocalIngestionService] ✅ Project found on server!');
            return {
                projectId: data.project.projectId,
                localHash: data.project.localHash,
                folderName: data.project.folderName,
                folderPath: data.project.folderPath,
                ingestionStatus: data.project.ingestionStatus,
                totalFiles: data.project.totalFiles,
                processedFiles: data.project.processedFiles,
                totalChunks: data.project.totalChunks,
            };
        } catch (error) {
            console.error('[LocalIngestionService] ❌ checkProjectExists error:', error);
            return undefined;
        }
    }

    protected async createProject(folderPath: string, folderName: string): Promise<LocalProjectInfo | undefined> {
        console.log('[LocalIngestionService] 🆕 createProject() called');
        console.log(`[LocalIngestionService] 🆕 Creating project: ${folderName}`);
        console.log(`[LocalIngestionService] 🆕 API URL: ${this._backendUrl}/api/local-projects/create`);

        try {
            const response = await fetch(`${this._backendUrl}/api/local-projects/create`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._authToken}`,
                },
                body: JSON.stringify({ folderPath, folderName }),
            });

            console.log(`[LocalIngestionService] 🆕 Response status: ${response.status}`);

            if (!response.ok) {
                console.error(`[LocalIngestionService] ❌ Create failed: ${response.statusText}`);
                throw new Error(`Create failed: ${response.statusText}`);
            }

            const data = await response.json();
            console.log(`[LocalIngestionService] 🆕 Response data:`, JSON.stringify(data, null, 2));
            console.log('[LocalIngestionService] ✅ Project created successfully!');

            return {
                projectId: data.projectId,
                localHash: data.localHash,
                folderName,
                folderPath,
                ingestionStatus: 'pending',
                totalFiles: 0,
                processedFiles: 0,
                totalChunks: 0,
            };
        } catch (error) {
            console.error('[LocalIngestionService] ❌ createProject error:', error);
            return undefined;
        }
    }

    protected async startIngestion(projectId: string, folderUri: URI): Promise<void> {
        console.log('[LocalIngestionService] ----------------------------------------');
        console.log('[LocalIngestionService] 📤 startIngestion() START');
        console.log(`[LocalIngestionService] 📤 Project ID: ${projectId}`);
        console.log(`[LocalIngestionService] 📤 Folder URI: ${folderUri.toString()}`);

        try {
            // Step 1: Collect all files from folder
            console.log('[LocalIngestionService] 📁 Step 1: Collecting files from folder...');
            const files = await this.collectFiles(folderUri);
            console.log(`[LocalIngestionService] 📁 Found ${files.length} files to ingest`);

            if (files.length === 0) {
                console.log('[LocalIngestionService] ⚠️ No files to ingest - skipping');
                return;
            }

            // Log first 10 files
            console.log('[LocalIngestionService] 📁 First 10 files:');
            files.slice(0, 10).forEach((f, i) => console.log(`[LocalIngestionService]    ${i + 1}. ${f.path} (${f.size} bytes)`));
            if (files.length > 10) {
                console.log(`[LocalIngestionService]    ... and ${files.length - 10} more files`);
            }

            // Step 2: Read all file contents ONCE
            console.log('[LocalIngestionService] 📖 Step 2: Reading file contents...');
            const filesWithContent: Array<{ path: string; content: string; size: number; lastModified?: number }> = [];
            let readErrors = 0;

            for (const file of files) {
                try {
                    const content = await this.fileService.read(file.uri);
                    filesWithContent.push({
                        path: file.path,
                        content: content.value.toString(),
                        size: file.size,
                        lastModified: Date.now(),
                    });
                } catch (error) {
                    readErrors++;
                    console.warn(`[LocalIngestionService] ⚠️ Failed to read file: ${file.path}`);
                }
            }

            console.log(`[LocalIngestionService] 📖 Successfully read ${filesWithContent.length} files (${readErrors} errors)`);

            if (filesWithContent.length === 0) {
                console.log('[LocalIngestionService] ❌ No files could be read - aborting');
                return;
            }

            // Step 3: Build Merkle tree
            console.log('[LocalIngestionService] 🌳 Step 3: Building Merkle tree...');
            const merkleTree = await this.merkleTreeService.buildTreeFromFiles(filesWithContent);
            this._currentMerkleTree = merkleTree;
            console.log(`[LocalIngestionService] 🌳 Merkle tree built!`);
            console.log(`[LocalIngestionService] 🌳 Root hash: ${merkleTree.hash}`);
            console.log(`[LocalIngestionService] 🌳 Total files in tree: ${merkleTree.children?.length || 0} top-level entries`);

            // Step 4: Initialize ingestion with Merkle tree
            console.log('[LocalIngestionService] 🚀 Step 4: Initializing ingestion on backend...');
            console.log(`[LocalIngestionService] 🚀 API URL: ${this._backendUrl}/api/local-ingest/${projectId}/init`);

            const initResponse = await fetch(`${this._backendUrl}/api/local-ingest/${projectId}/init`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._authToken}`,
                },
                body: JSON.stringify({
                    totalFiles: filesWithContent.length,
                    merkleTree,
                }),
            });

            console.log(`[LocalIngestionService] 🚀 Init response status: ${initResponse.status}`);

            // Step 5: Send files in batches
            console.log('[LocalIngestionService] 📦 Step 5: Sending files in batches...');
            const batchSize = 20;
            const totalBatches = Math.ceil(filesWithContent.length / batchSize);
            console.log(`[LocalIngestionService] 📦 Batch size: ${batchSize}, Total batches: ${totalBatches}`);

            for (let i = 0; i < filesWithContent.length; i += batchSize) {
                const batch = filesWithContent.slice(i, i + batchSize);
                const batchIndex = Math.floor(i / batchSize);
                const batchNum = batchIndex + 1;

                console.log(`[LocalIngestionService] 📦 Sending batch ${batchNum}/${totalBatches} (${batch.length} files)...`);

                const response = await fetch(`${this._backendUrl}/api/local-ingest/${projectId}/files`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this._authToken}`,
                    },
                    body: JSON.stringify({
                        files: batch,
                        batchIndex,
                        totalBatches,
                    }),
                });

                console.log(`[LocalIngestionService] 📦 Batch ${batchNum} response status: ${response.status}`);

                if (response.ok) {
                    const result = await response.json();
                    const percent = Math.round((result.totalProcessed / filesWithContent.length) * 100);

                    console.log(`[LocalIngestionService] 📦 Batch ${batchNum} processed: ${result.totalProcessed}/${filesWithContent.length} files (${percent}%)`);
                    console.log(`[LocalIngestionService] 📦 Total chunks so far: ${result.totalChunks}`);

                    this.onIngestionProgressEmitter.fire({
                        projectId,
                        status: result.isComplete ? 'completed' : 'processing',
                        progress: {
                            total: filesWithContent.length,
                            processed: result.totalProcessed,
                            chunks: result.totalChunks,
                            percent,
                        },
                    });

                    if (result.isComplete) {
                        console.log('[LocalIngestionService] ✅ All batches processed - Ingestion COMPLETE!');
                        console.log(`[LocalIngestionService] ✅ Final stats: ${result.totalProcessed} files, ${result.totalChunks} chunks`);

                        this._currentProject = {
                            ...this._currentProject!,
                            ingestionStatus: 'completed',
                            processedFiles: result.totalProcessed,
                            totalChunks: result.totalChunks,
                        };
                        this.onIngestionCompleteEmitter.fire(this._currentProject);
                    }
                } else {
                    console.error(`[LocalIngestionService] ❌ Batch ${batchNum} failed: ${response.statusText}`);
                }
            }

            console.log('[LocalIngestionService] 📤 startIngestion() END');
            console.log('[LocalIngestionService] ----------------------------------------');
        } catch (error) {
            console.error('[LocalIngestionService] Ingestion error:', error);
            this.onIngestionErrorEmitter.fire({
                projectId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }

    protected async collectFiles(folderUri: URI): Promise<Array<{ uri: URI; path: string; size: number }>> {
        console.log('[LocalIngestionService] 📁 collectFiles() START');
        console.log(`[LocalIngestionService] 📁 Root folder: ${folderUri.path.toString()}`);

        const files: Array<{ uri: URI; path: string; size: number }> = [];
        const rootPath = folderUri.path.toString();
        let dirsTraversed = 0;
        let filesChecked = 0;
        let skippedDirs = 0;
        let skippedFiles = 0;
        let largeFilesSkipped = 0;

        const traverse = async (uri: URI): Promise<void> => {
            try {
                const stat = await this.fileService.resolve(uri);

                if (!stat) {
                    return;
                }

                if (stat.isDirectory) {
                    dirsTraversed++;
                    // Check if directory should be ignored
                    const dirName = uri.path.base;
                    if (IGNORE_DIRS.has(dirName)) {
                        skippedDirs++;
                        return;
                    }

                    if (stat.children) {
                        await Promise.all(stat.children.map(child => traverse(child.resource)));
                    }
                } else if (stat.isFile) {
                    filesChecked++;
                    // Check if file should be included
                    const ext = uri.path.ext.toLowerCase();

                    if (IGNORE_EXTENSIONS.has(ext)) {
                        skippedFiles++;
                        return;
                    }

                    if (!CODE_EXTENSIONS.has(ext)) {
                        skippedFiles++;
                        return;
                    }

                    // Skip large files (> 1MB)
                    if (stat.size && stat.size > 1024 * 1024) {
                        largeFilesSkipped++;
                        return;
                    }

                    // Get relative path
                    const fullPath = uri.path.toString();
                    const relativePath = fullPath.startsWith(rootPath)
                        ? fullPath.slice(rootPath.length + 1)
                        : fullPath;

                    files.push({
                        uri,
                        path: relativePath,
                        size: stat.size || 0,
                    });
                }
            } catch (error) {
                console.warn(`[LocalIngestionService] ⚠️ Error accessing: ${uri.toString()}`);
            }
        };

        await traverse(folderUri);

        console.log('[LocalIngestionService] 📁 collectFiles() DONE');
        console.log(`[LocalIngestionService] 📁 Stats: ${dirsTraversed} dirs traversed, ${filesChecked} files checked`);
        console.log(`[LocalIngestionService] 📁 Skipped: ${skippedDirs} dirs, ${skippedFiles} files by extension, ${largeFilesSkipped} large files`);
        console.log(`[LocalIngestionService] 📁 Result: ${files.length} files to process`);

        return files;
    }

    protected async pollIngestionProgress(projectId: string): Promise<void> {
        console.log('[LocalIngestionService] ⏳ pollIngestionProgress() START');
        console.log(`[LocalIngestionService] ⏳ Polling project: ${projectId}`);
        let pollCount = 0;

        const poll = async () => {
            pollCount++;
            console.log(`[LocalIngestionService] ⏳ Poll #${pollCount}...`);

            try {
                const response = await fetch(`${this._backendUrl}/api/local-ingest/${projectId}/progress`, {
                    headers: {
                        'Authorization': `Bearer ${this._authToken}`,
                    },
                });

                console.log(`[LocalIngestionService] ⏳ Poll response status: ${response.status}`);

                if (!response.ok) {
                    console.warn('[LocalIngestionService] ⚠️ Poll response not OK, stopping');
                    return;
                }

                const data = await response.json();
                console.log(`[LocalIngestionService] ⏳ Status: ${data.status}, Progress: ${data.progress?.processed}/${data.progress?.total} (${data.progress?.percent}%)`);

                this.onIngestionProgressEmitter.fire({
                    projectId,
                    status: data.status,
                    progress: data.progress,
                    error: data.error,
                });

                if (data.status === 'processing') {
                    console.log('[LocalIngestionService] ⏳ Still processing, will poll again in 2s...');
                    setTimeout(poll, 2000);
                } else if (data.status === 'completed') {
                    console.log('[LocalIngestionService] ✅ Polling complete - Ingestion COMPLETED!');
                    console.log(`[LocalIngestionService] ✅ Final: ${data.progress.processed} files, ${data.progress.chunks} chunks`);

                    this._currentProject = {
                        ...this._currentProject!,
                        ingestionStatus: 'completed',
                        processedFiles: data.progress.processed,
                        totalChunks: data.progress.chunks,
                    };
                    this.onIngestionCompleteEmitter.fire(this._currentProject);
                } else if (data.status === 'failed') {
                    console.error('[LocalIngestionService] ❌ Polling complete - Ingestion FAILED!');
                    console.error(`[LocalIngestionService] ❌ Error: ${data.error}`);

                    this.onIngestionErrorEmitter.fire({
                        projectId,
                        error: data.error || 'Ingestion failed',
                    });
                }
            } catch (error) {
                console.error('[LocalIngestionService] ❌ Poll error:', error);
            }
        };

        poll();
    }

    async getProjectStatus(projectId: string): Promise<LocalProjectInfo | undefined> {
        console.log('[LocalIngestionService] 📊 getProjectStatus() called');
        console.log(`[LocalIngestionService] 📊 Project ID: ${projectId}`);

        try {
            const response = await fetch(`${this._backendUrl}/api/local-projects/${projectId}/status`, {
                headers: {
                    'Authorization': `Bearer ${this._authToken}`,
                },
            });

            console.log(`[LocalIngestionService] 📊 Response status: ${response.status}`);

            if (!response.ok) {
                console.warn(`[LocalIngestionService] ⚠️ Get status failed: ${response.statusText}`);
                return undefined;
            }

            const data = await response.json();
            console.log(`[LocalIngestionService] 📊 Project status: ${data.project?.ingestionStatus}`);
            return data.project;
        } catch (error) {
            console.error('[LocalIngestionService] ❌ Get status error:', error);
            return undefined;
        }
    }

    async retryIngestion(projectId: string): Promise<void> {
        console.log('[LocalIngestionService] 🔄 retryIngestion() called');
        console.log(`[LocalIngestionService] 🔄 Project ID: ${projectId}`);

        try {
            const response = await fetch(`${this._backendUrl}/api/local-ingest/${projectId}/retry`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this._authToken}`,
                },
            });

            console.log(`[LocalIngestionService] 🔄 Retry response status: ${response.status}`);

            // Re-ingest the current workspace
            console.log('[LocalIngestionService] 🔄 Re-checking workspace after retry...');
            await this.checkAndIngestWorkspace();
        } catch (error) {
            console.error('[LocalIngestionService] ❌ Retry error:', error);
        }
    }

    async getMerkleTree(projectId: string): Promise<MerkleNodeJSON | undefined> {
        console.log('[LocalIngestionService] 🌳 getMerkleTree() called');
        console.log(`[LocalIngestionService] 🌳 Project ID: ${projectId}`);

        try {
            const response = await fetch(`${this._backendUrl}/api/local-ingest/${projectId}/merkle`, {
                headers: {
                    'Authorization': `Bearer ${this._authToken}`,
                },
            });

            console.log(`[LocalIngestionService] 🌳 Response status: ${response.status}`);

            if (!response.ok) {
                console.warn(`[LocalIngestionService] ⚠️ Get Merkle tree failed: ${response.statusText}`);
                return undefined;
            }

            const data = await response.json();
            console.log(`[LocalIngestionService] 🌳 Merkle tree hash: ${data.merkleTree?.hash?.substring(0, 16)}...`);
            return data.merkleTree;
        } catch (error) {
            console.error('[LocalIngestionService] ❌ Get Merkle tree error:', error);
            return undefined;
        }
    }

    async updateMerkleTree(projectId: string, merkleTree: MerkleNodeJSON): Promise<void> {
        console.log('[LocalIngestionService] 🌳 updateMerkleTree() called');
        console.log(`[LocalIngestionService] 🌳 Project ID: ${projectId}`);
        console.log(`[LocalIngestionService] 🌳 New tree hash: ${merkleTree.hash.substring(0, 16)}...`);

        try {
            const response = await fetch(`${this._backendUrl}/api/local-ingest/${projectId}/merkle`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._authToken}`,
                },
                body: JSON.stringify({ merkleTree }),
            });

            console.log(`[LocalIngestionService] 🌳 Update response status: ${response.status}`);

            if (response.ok) {
                this._currentMerkleTree = merkleTree;
                console.log('[LocalIngestionService] ✅ Merkle tree updated successfully');
            } else {
                console.warn(`[LocalIngestionService] ⚠️ Update Merkle tree failed: ${response.statusText}`);
            }
        } catch (error) {
            console.error('[LocalIngestionService] ❌ Update Merkle tree error:', error);
        }
    }

    /**
     * Sync local files with backend using Merkle tree comparison
     * This is the main method to call when files change locally
     * It compares Merkle trees and only sends changed files
     */
    async syncWithMerkle(projectId: string, folderUri: URI): Promise<MerkleSyncResult> {
        console.log('[LocalIngestionService] ========================================');
        console.log('[LocalIngestionService] 🔄 syncWithMerkle() START');
        console.log(`[LocalIngestionService] 🔄 Project ID: ${projectId}`);
        console.log(`[LocalIngestionService] 🔄 Folder URI: ${folderUri.toString()}`);

        try {
            // Step 1: Collect all local files
            console.log('[LocalIngestionService] 📁 Step 1: Collecting local files...');
            const files = await this.collectFiles(folderUri);
            console.log(`[LocalIngestionService] 📁 Found ${files.length} local files`);

            if (files.length === 0) {
                console.log('[LocalIngestionService] ⚠️ No files found - returning empty sync result');
                console.log('[LocalIngestionService] ========================================');
                return { success: true, summary: { added: 0, modified: 0, deleted: 0, total: 0 } };
            }

            // Step 2: Read all file contents ONCE (reuse for both Merkle tree and sync)
            console.log('[LocalIngestionService] 📖 Step 2: Reading file contents...');
            const filesWithContent: Array<{ path: string; content: string; size: number }> = [];
            const fileContentMap = new Map<string, string>();
            let readErrors = 0;

            for (const file of files) {
                try {
                    const content = await this.fileService.read(file.uri);
                    const contentStr = content.value.toString();
                    filesWithContent.push({
                        path: file.path,
                        content: contentStr,
                        size: file.size,
                    });
                    fileContentMap.set(file.path, contentStr);
                } catch (error) {
                    readErrors++;
                    console.warn(`[LocalIngestionService] ⚠️ Failed to read file: ${file.path}`);
                }
            }

            console.log(`[LocalIngestionService] 📖 Read ${filesWithContent.length} files successfully (${readErrors} errors)`);

            // Step 3: Build new Merkle tree from local files
            console.log('[LocalIngestionService] 🌳 Step 3: Building new Merkle tree...');
            const newMerkleTree = await this.merkleTreeService.buildTreeFromFiles(filesWithContent);
            console.log(`[LocalIngestionService] 🌳 New Merkle tree built!`);
            console.log(`[LocalIngestionService] 🌳 Root hash: ${newMerkleTree.hash}`);
            console.log(`[LocalIngestionService] 🌳 Top-level entries: ${newMerkleTree.children?.length || 0}`);

            // Step 4: Call backend merkle-sync endpoint (first call - send tree, get changed files list)
            console.log('[LocalIngestionService] 📤 Step 4: Calling backend merkle-sync (Phase 1: Compare trees)...');
            console.log(`[LocalIngestionService] 📤 API URL: ${this._backendUrl}/api/projects/${projectId}/merkle-sync`);

            const syncResponse = await fetch(`${this._backendUrl}/api/projects/${projectId}/merkle-sync`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._authToken}`,
                },
                body: JSON.stringify({ merkleTree: newMerkleTree }),
            });

            console.log(`[LocalIngestionService] 📤 Sync response status: ${syncResponse.status}`);

            if (!syncResponse.ok) {
                const errorData = await syncResponse.json().catch(() => ({}));
                console.error(`[LocalIngestionService] ❌ Merkle sync failed: ${errorData.error || syncResponse.statusText}`);
                console.log('[LocalIngestionService] ========================================');
                return { success: false, error: errorData.error || syncResponse.statusText };
            }

            const syncResult = await syncResponse.json();
            console.log('[LocalIngestionService] 📊 Backend comparison result:');
            console.log(`[LocalIngestionService] 📊 - Changes detected: ${syncResult.summary?.total || 0}`);
            console.log(`[LocalIngestionService] 📊   - Added: ${syncResult.summary?.added || 0}`);
            console.log(`[LocalIngestionService] 📊   - Modified: ${syncResult.summary?.modified || 0}`);
            console.log(`[LocalIngestionService] 📊   - Deleted: ${syncResult.summary?.deleted || 0}`);
            console.log(`[LocalIngestionService] 📊 - Files needing content: ${syncResult.needsFiles?.length || 0}`);

            // If no files need content, we're done (just deleted files or no changes)
            if (!syncResult.needsFiles || syncResult.needsFiles.length === 0) {
                console.log('[LocalIngestionService] ✅ No file content needed - Sync complete (no adds/modifications)');
                this._currentMerkleTree = newMerkleTree;
                console.log('[LocalIngestionService] ========================================');
                return {
                    success: true,
                    changes: syncResult.changes,
                    summary: syncResult.summary,
                    filesProcessed: 0,
                    filesDeleted: syncResult.summary?.deleted || 0,
                };
            }

            // Step 5: Send changed files content back to complete the sync
            console.log(`[LocalIngestionService] 📤 Step 5: Sending ${syncResult.needsFiles.length} changed file contents (Phase 2)...`);

            // Log files that need to be sent
            console.log('[LocalIngestionService] 📤 Files to send:');
            syncResult.needsFiles.slice(0, 10).forEach((f: string, i: number) => console.log(`[LocalIngestionService]    ${i + 1}. ${f}`));
            if (syncResult.needsFiles.length > 10) {
                console.log(`[LocalIngestionService]    ... and ${syncResult.needsFiles.length - 10} more files`);
            }

            const changedFiles: Record<string, { content: string }> = {};
            let filesFound = 0;
            let filesMissing = 0;

            for (const filePath of syncResult.needsFiles) {
                const content = fileContentMap.get(filePath);
                if (content !== undefined) {
                    changedFiles[filePath] = { content };
                    filesFound++;
                } else {
                    console.warn(`[LocalIngestionService] ⚠️ File not in content map: ${filePath}`);
                    filesMissing++;
                }
            }

            console.log(`[LocalIngestionService] 📤 Prepared ${filesFound} files (${filesMissing} missing)`);

            const completeResponse = await fetch(`${this._backendUrl}/api/projects/${projectId}/merkle-sync`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._authToken}`,
                },
                body: JSON.stringify({
                    merkleTree: newMerkleTree,
                    files: changedFiles,
                }),
            });

            console.log(`[LocalIngestionService] 📤 Complete response status: ${completeResponse.status}`);

            if (!completeResponse.ok) {
                const errorData = await completeResponse.json().catch(() => ({}));
                console.error(`[LocalIngestionService] ❌ Send files failed: ${errorData.error || completeResponse.statusText}`);
                console.log('[LocalIngestionService] ========================================');
                return { success: false, error: errorData.error || completeResponse.statusText };
            }

            const completeResult = await completeResponse.json();
            this._currentMerkleTree = newMerkleTree;

            console.log('[LocalIngestionService] ✅ MERKLE SYNC COMPLETE!');
            console.log(`[LocalIngestionService] ✅ Files processed: ${completeResult.filesProcessed || 0}`);
            console.log(`[LocalIngestionService] ✅ Files deleted: ${completeResult.filesDeleted || 0}`);
            console.log(`[LocalIngestionService] ✅ New chunks created: ${completeResult.chunksCreated || 'N/A'}`);
            console.log('[LocalIngestionService] 🔄 syncWithMerkle() END');
            console.log('[LocalIngestionService] ========================================');

            return {
                success: true,
                changes: completeResult.changes,
                summary: completeResult.summary,
                filesProcessed: completeResult.filesProcessed,
                filesDeleted: completeResult.filesDeleted,
            };
        } catch (error) {
            console.error('[LocalIngestionService] ❌ Merkle sync error:', error);
            console.log('[LocalIngestionService] ========================================');
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
}
