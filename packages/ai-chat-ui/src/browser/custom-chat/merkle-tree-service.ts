// *****************************************************************************
// Merkle Tree Service for Browser
// Builds Merkle trees from local files using Web Crypto API
// IMPORTANT: Hashing algorithm MUST match backend/src/services/merkle/hasher.ts
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';

export enum NodeType {
    File = 'File',
    Directory = 'Directory',
}

export enum ChangeType {
    Added = 'Added',
    Modified = 'Modified',
    Deleted = 'Deleted',
}

export interface MerkleNodeJSON {
    hash: string;
    nodeType: NodeType;
    path: string;
    size: number;
    modifiedAt: number;
    createdAt: number;
    children?: MerkleNodeJSON[];
    isLeaf: boolean;
}

export interface FileChange {
    changeType: ChangeType;
    path: string;
    oldHash?: string;
    newHash?: string;
}

export interface ChangeSummary {
    added: number;
    modified: number;
    deleted: number;
    total: number;
}

export interface FileInput {
    path: string;
    content: string;
    size?: number;
    lastModified?: number;
}

export interface MerkleSyncResult {
    changes: FileChange[];
    summary: ChangeSummary;
    filesToProcess: string[];
    deletedFiles: string[];
}

export const MerkleTreeService = Symbol('MerkleTreeService');

export interface MerkleTreeService {
    buildTreeFromFiles(files: FileInput[]): Promise<MerkleNodeJSON>;
    hashContent(content: string): Promise<string>;
    compareTrees(oldTree: MerkleNodeJSON | null, newTree: MerkleNodeJSON): MerkleSyncResult;
    getFilesToProcess(changes: FileChange[]): string[];
}

@injectable()
export class MerkleTreeServiceImpl implements MerkleTreeService {

    /**
     * Hash content using SHA-256 (Web Crypto API)
     * MUST match backend: crypto.createHash('sha256').update(content).digest('hex')
     */
    async hashContent(content: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(content);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Hash a directory by combining children hashes
     * MUST match backend: sorted_children.map(c => c.hash + c.path).join('')
     */
    protected async hashDirectory(children: Array<{ hash: string; path: string }>): Promise<string> {
        // Sort children by path for consistent hashing (matching backend)
        const sorted = [...children].sort((a, b) => a.path.localeCompare(b.path));

        // Combine all hashes and paths (matching backend format exactly)
        const combined = sorted.map(c => c.hash + c.path).join('');
        return this.hashContent(combined);
    }

    /**
     * Build Merkle tree from file list with content
     */
    async buildTreeFromFiles(files: FileInput[]): Promise<MerkleNodeJSON> {
        console.log('[MerkleTreeService] 🌳 buildTreeFromFiles() START');
        console.log(`[MerkleTreeService] 🌳 Input files: ${files.length}`);

        if (files.length === 0) {
            // Return empty root with proper hash
            const emptyHash = await this.hashContent('');
            console.log(`[MerkleTreeService] 🌳 Empty tree, hash: ${emptyHash.substring(0, 16)}...`);
            return {
                hash: emptyHash,
                nodeType: NodeType.Directory,
                path: 'root',
                size: 0,
                modifiedAt: Math.floor(Date.now() / 1000),
                createdAt: Math.floor(Date.now() / 1000),
                children: [],
                isLeaf: false,
            };
        }

        // Build nested structure
        console.log('[MerkleTreeService] 🌳 Building nested structure...');
        const root = this.buildNestedStructure(files);

        // Convert to Merkle tree
        console.log('[MerkleTreeService] 🌳 Converting to Merkle tree...');
        const tree = await this.buildTreeFromNested(root, 'root');

        console.log('[MerkleTreeService] 🌳 buildTreeFromFiles() DONE');
        console.log(`[MerkleTreeService] 🌳 Root hash: ${tree.hash}`);
        console.log(`[MerkleTreeService] 🌳 Children: ${tree.children?.length || 0}`);

        return tree;
    }

    /**
     * Build nested file structure from flat file list
     * Matches backend buildNestedStructure exactly
     */
    protected buildNestedStructure(files: FileInput[]): NestedNode {
        const root: NestedNode = { type: 'directory', children: {} };

        for (const file of files) {
            const parts = file.path.split('/');
            let current = root;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isLast = i === parts.length - 1;

                if (isLast) {
                    // It's a file
                    current.children![part] = {
                        type: 'file',
                        content: file.content,
                        size: file.size,
                        lastModified: file.lastModified || Date.now(),
                    };
                } else {
                    // It's a directory
                    if (!current.children![part]) {
                        current.children![part] = { type: 'directory', children: {} };
                    }
                    current = current.children![part];
                }
            }
        }

        return root;
    }

    /**
     * Recursively build Merkle tree from nested structure
     * Matches backend buildTreeFromNested exactly
     */
    protected async buildTreeFromNested(node: NestedNode, path: string): Promise<MerkleNodeJSON> {
        if (node.type === 'file') {
            const hash = await this.hashContent(node.content!);
            // Size calculation: use TextEncoder for proper UTF-8 byte length
            // This matches backend's Buffer.from(content).length
            const byteLength = new TextEncoder().encode(node.content!).length;

            return {
                hash,
                nodeType: NodeType.File,
                path,
                size: node.size ?? byteLength,
                modifiedAt: Math.floor((node.lastModified || Date.now()) / 1000),
                createdAt: Math.floor((node.lastModified || Date.now()) / 1000),
                isLeaf: true,
            };
        }

        // It's a directory
        const children: MerkleNodeJSON[] = [];
        const entries = Object.entries(node.children || {});

        for (const [name, childNode] of entries) {
            // Path construction matches backend: path === 'root' ? name : `${path}/${name}`
            const childPath = path === 'root' ? name : `${path}/${name}`;
            const childMerkleNode = await this.buildTreeFromNested(childNode, childPath);
            children.push(childMerkleNode);
        }

        // Sort children by path (matching backend)
        children.sort((a, b) => a.path.localeCompare(b.path));

        // Hash directory using same algorithm as backend
        const hash = await this.hashDirectory(
            children.map(c => ({ hash: c.hash, path: c.path }))
        );

        return {
            hash,
            nodeType: NodeType.Directory,
            path,
            size: 0,
            modifiedAt: Math.floor(Date.now() / 1000),
            createdAt: Math.floor(Date.now() / 1000),
            children,
            isLeaf: false,
        };
    }

    /**
     * Compare two Merkle trees and find all differences
     * Matches backend compareTrees from comparator.ts
     */
    compareTrees(oldTree: MerkleNodeJSON | null, newTree: MerkleNodeJSON): MerkleSyncResult {
        console.log('[MerkleTreeService] 🔍 compareTrees() START');
        console.log(`[MerkleTreeService] 🔍 Old tree hash: ${oldTree?.hash?.substring(0, 16) || 'NULL'}...`);
        console.log(`[MerkleTreeService] 🔍 New tree hash: ${newTree.hash.substring(0, 16)}...`);

        const changes: FileChange[] = [];

        if (!oldTree) {
            // First sync - all files in new tree are "added"
            console.log('[MerkleTreeService] 🔍 No old tree - treating all as ADDED');
            this.collectAddedRecursive(newTree, changes);
        } else if (oldTree.hash === newTree.hash) {
            // No changes
            console.log('[MerkleTreeService] 🔍 Trees are IDENTICAL - no changes');
        } else {
            console.log('[MerkleTreeService] 🔍 Trees differ - comparing recursively...');
            this.compareTreesRecursive(oldTree, newTree, changes);
        }

        const summary = this.summarizeChanges(changes);
        const filesToProcess = this.getFilesToProcess(changes);
        const deletedFiles = changes
            .filter(c => c.changeType === ChangeType.Deleted)
            .map(c => c.path);

        console.log('[MerkleTreeService] 🔍 compareTrees() DONE');
        console.log(`[MerkleTreeService] 🔍 Changes: ${summary.total} (added: ${summary.added}, modified: ${summary.modified}, deleted: ${summary.deleted})`);
        console.log(`[MerkleTreeService] 🔍 Files to process: ${filesToProcess.length}`);
        console.log(`[MerkleTreeService] 🔍 Files to delete: ${deletedFiles.length}`);

        return { changes, summary, filesToProcess, deletedFiles };
    }

    /**
     * Recursively compare trees and collect changes
     */
    protected compareTreesRecursive(
        oldNode: MerkleNodeJSON,
        newNode: MerkleNodeJSON,
        changes: FileChange[]
    ): void {
        // If hashes are the same, no changes in this subtree
        if (oldNode.hash === newNode.hash) {
            return;
        }

        // Both are files - it's a modification
        if (oldNode.isLeaf && newNode.isLeaf) {
            changes.push({
                changeType: ChangeType.Modified,
                path: newNode.path,
                oldHash: oldNode.hash,
                newHash: newNode.hash,
            });
            return;
        }

        // Both are directories - compare children
        if (!oldNode.isLeaf && !newNode.isLeaf) {
            const oldChildren = oldNode.children || [];
            const newChildren = newNode.children || [];

            // Create maps for efficient lookup
            const oldMap = new Map<string, MerkleNodeJSON>();
            const newMap = new Map<string, MerkleNodeJSON>();

            for (const child of oldChildren) {
                oldMap.set(child.path, child);
            }

            for (const child of newChildren) {
                newMap.set(child.path, child);
            }

            // Find deleted files/directories
            for (const [path, oldChild] of oldMap) {
                if (!newMap.has(path)) {
                    this.collectDeletedRecursive(oldChild, changes);
                }
            }

            // Find added and modified files/directories
            for (const [path, newChild] of newMap) {
                const oldChild = oldMap.get(path);
                if (oldChild) {
                    // File/directory exists in both - check for modifications
                    if (oldChild.hash !== newChild.hash) {
                        this.compareTreesRecursive(oldChild, newChild, changes);
                    }
                } else {
                    // New file/directory
                    this.collectAddedRecursive(newChild, changes);
                }
            }
        } else {
            // Type changed (file -> directory or directory -> file)
            // Treat as delete + add
            this.collectDeletedRecursive(oldNode, changes);
            this.collectAddedRecursive(newNode, changes);
        }
    }

    /**
     * Recursively collect all files in a deleted subtree
     */
    protected collectDeletedRecursive(node: MerkleNodeJSON, changes: FileChange[]): void {
        if (node.isLeaf) {
            changes.push({
                changeType: ChangeType.Deleted,
                path: node.path,
                oldHash: node.hash,
            });
        } else if (node.children) {
            for (const child of node.children) {
                this.collectDeletedRecursive(child, changes);
            }
        }
    }

    /**
     * Recursively collect all files in an added subtree
     */
    protected collectAddedRecursive(node: MerkleNodeJSON, changes: FileChange[]): void {
        if (node.isLeaf) {
            changes.push({
                changeType: ChangeType.Added,
                path: node.path,
                newHash: node.hash,
            });
        } else if (node.children) {
            for (const child of node.children) {
                this.collectAddedRecursive(child, changes);
            }
        }
    }

    /**
     * Get summary statistics of changes
     */
    protected summarizeChanges(changes: FileChange[]): ChangeSummary {
        const summary: ChangeSummary = {
            added: 0,
            modified: 0,
            deleted: 0,
            total: 0,
        };

        for (const change of changes) {
            switch (change.changeType) {
                case ChangeType.Added:
                    summary.added++;
                    break;
                case ChangeType.Modified:
                    summary.modified++;
                    break;
                case ChangeType.Deleted:
                    summary.deleted++;
                    break;
            }
        }

        summary.total = summary.added + summary.modified + summary.deleted;
        return summary;
    }

    /**
     * Get only files that need to be processed (added or modified)
     */
    getFilesToProcess(changes: FileChange[]): string[] {
        return changes
            .filter(c => c.changeType === ChangeType.Added || c.changeType === ChangeType.Modified)
            .map(c => c.path);
    }
}

interface NestedNode {
    type: 'file' | 'directory';
    content?: string;
    size?: number;
    lastModified?: number;
    children?: Record<string, NestedNode>;
}
