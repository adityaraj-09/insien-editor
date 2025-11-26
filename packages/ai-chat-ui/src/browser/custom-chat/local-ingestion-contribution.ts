// *****************************************************************************
// Local Ingestion Frontend Contribution
// Initializes the LocalIngestionService when the app starts
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, FrontendApplication } from '@theia/core/lib/browser';
import { LocalIngestionService } from './local-ingestion-service';
import { BackendChatService } from './backend-chat-service';

// Configuration for the custom backend
// TODO: Move these to preferences/environment variables
const BACKEND_URL = 'http://localhost:3001';
const AUTH_TOKEN = 'dev-token'; // TODO: Get from authentication service

@injectable()
export class LocalIngestionContribution implements FrontendApplicationContribution {

    @inject(LocalIngestionService)
    protected readonly ingestionService: LocalIngestionService;

    @inject(BackendChatService)
    protected readonly backendChatService: BackendChatService;

    /**
     * Called when the frontend application starts
     */
    async onStart(app: FrontendApplication): Promise<void> {
        console.log('[LocalIngestionContribution] 🚀 onStart() - App is starting...');
        console.log(`[LocalIngestionContribution] 🔧 Backend URL: ${BACKEND_URL}`);
        console.log(`[LocalIngestionContribution] 🔧 Auth token present: ${!!AUTH_TOKEN}`);

        // Initialize the backend chat service (which also initializes ingestion service)
        console.log('[LocalIngestionContribution] 🔧 Initializing BackendChatService...');
        this.backendChatService.initialize(BACKEND_URL, AUTH_TOKEN);

        console.log('[LocalIngestionContribution] ✅ Services initialized!');
    }

    /**
     * Called after the shell is attached (app is fully loaded)
     * This is a good place to trigger initial workspace ingestion
     */
    onDidInitializeLayout?(app: FrontendApplication): Promise<void> | void {
        console.log('[LocalIngestionContribution] 📂 onDidInitializeLayout() - Shell is ready');
        console.log('[LocalIngestionContribution] 📂 Workspace ingestion will be triggered by LocalIngestionService');
        // The LocalIngestionService.checkAndIngestWorkspace() is already called
        // in its initialize() method, so we don't need to call it again here
    }
}
