// *****************************************************************************
// Copyright (C) 2018 Ericsson and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { codicon, CommonCommands, Key, KeyCode, LabelProvider, Message, ReactWidget } from '@theia/core/lib/browser';
import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
import { CommandRegistry, Path } from '@theia/core/lib/common';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { WorkspaceCommands, WorkspaceService } from '@theia/workspace/lib/browser';

/**
 * Default implementation of the `GettingStartedWidget`.
 * The widget is displayed when there are currently no workspaces present.
 * Some of the features displayed include:
 * - `open` commands.
 * - `recently used workspaces`.
 * - `settings` commands.
 * - `help` commands.
 * - helpful links.
 */
@injectable()
export class GettingStartedWidget extends ReactWidget {

    /**
     * The widget `id`.
     */
    static readonly ID = 'getting.started.widget';
    /**
     * The widget `label` which is used for display purposes.
     */
    static readonly LABEL = nls.localizeByDefault('Welcome');

    /**
     * The application name which is used for display purposes.
     */
    protected applicationName = FrontendApplicationConfigProvider.get().applicationName;

    protected home: string | undefined;

    /**
     * The recently used workspaces limit.
     * Used in order to limit the number of recently used workspaces to display.
     */
    protected recentLimit = 5;
    /**
     * The list of recently used workspaces.
     */
    protected recentWorkspaces: string[] = [];

    @inject(CommandRegistry)
    protected readonly commandRegistry: CommandRegistry;

    @inject(EnvVariablesServer)
    protected readonly environments: EnvVariablesServer;

    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @postConstruct()
    protected init(): void {
        this.doInit();
    }

    protected async doInit(): Promise<void> {
        this.id = GettingStartedWidget.ID;
        this.title.label = GettingStartedWidget.LABEL;
        this.title.caption = GettingStartedWidget.LABEL;
        this.title.closable = true;

        this.recentWorkspaces = await this.workspaceService.recentWorkspaces();
        this.home = new URI(await this.environments.getHomeDirUri()).path.toString();

        this.update();
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        const elArr = this.node.getElementsByTagName('a');
        if (elArr && elArr.length > 0) {
            (elArr[0] as HTMLElement).focus();
        }
    }

    /**
     * Render the content of the widget.
     */
    protected render(): React.ReactNode {
        return <div className='gs-container'>
            <div className='gs-main'>
                <div className='gs-content-wrapper'>
                    {this.renderHeader()}
                    <div className='gs-content-container'>
                        <div className='gs-layout'>
                            {this.renderActions()}
                            {this.renderRecentWorkspaces()}
                        </div>
                    </div>
                </div>
            </div>
        </div>;
    }

    /**
     * Render the widget header.
     * Renders the title `{applicationName} Getting Started`.
     */
    protected renderHeader(): React.ReactNode {
        return <div className='gs-header'>
            <div className='gs-header-brand'>
                <svg className='gs-logo' fill='none' viewBox='0 0 48 48' xmlns='http://www.w3.org/2000/svg'>
                    <path d='M24.0002 4.66602L43.3335 17.3327V42.666L24.0002 29.9993L24.0002 4.66602Z' fill='currentColor' fillOpacity='0.3'></path>
                    <path d='M24.0002 4.66602L4.66699 17.3327V42.666L24.0002 29.9993V4.66602Z' fill='currentColor'></path>
                </svg>
                <h1 className='gs-app-name'>Insien</h1>
            </div>
            <button
                className='gs-settings-btn'
                onClick={this.doOpenPreferences}
                onKeyDown={this.doOpenPreferencesEnter}
                aria-label='Settings'>
                <i className={codicon('settings-gear')}></i>
            </button>
        </div>;
    }

    /**
     * Render the actions section.
     * Displays action cards for opening projects and other operations.
     */
    protected renderActions(): React.ReactNode {
        return <div className='gs-actions-column'>
            <a
                className='gs-action-card'
                role='button'
                tabIndex={0}
                onClick={this.doOpenFolder}
                onKeyDown={this.doOpenFolderEnter}>
                <div className='gs-action-icon'>
                    <i className={codicon('folder-opened')}></i>
                </div>
                <div className='gs-action-content'>
                    <h3 className='gs-action-title'>{nls.localizeByDefault('Open Folder')}</h3>
                    <p className='gs-action-description'>Browse and open an existing project</p>
                </div>
            </a>
            <a
                className='gs-action-card'
                role='button'
                tabIndex={0}
                onClick={this.doOpenWorkspace}
                onKeyDown={this.doOpenWorkspaceEnter}>
                <div className='gs-action-icon'>
                    <i className={codicon('repo-clone')}></i>
                </div>
                <div className='gs-action-content'>
                    <h3 className='gs-action-title'>{nls.localizeByDefault('Open Workspace')}</h3>
                    <p className='gs-action-description'>Open a workspace configuration file</p>
                </div>
            </a>
            <a
                className='gs-action-card'
                role='button'
                tabIndex={0}
                onClick={this.doCreateFile}
                onKeyDown={this.doCreateFileEnter}>
                <div className='gs-action-icon'>
                    <i className={codicon('file-add')}></i>
                </div>
                <div className='gs-action-content'>
                    <h3 className='gs-action-title'>{nls.localizeByDefault('New File...')}</h3>
                    <p className='gs-action-description'>Create a new file in the workspace</p>
                </div>
            </a>
        </div>;
    }

    /**
     * Render the recently used workspaces section.
     */
    protected renderRecentWorkspaces(): React.ReactNode {
        const items = this.recentWorkspaces;
        const paths = this.buildPaths(items);
        const content = paths.slice(0, this.recentLimit).map((item, index) =>
            <a
                className='gs-recent-item'
                key={index}
                role='button'
                tabIndex={0}
                onClick={() => this.open(new URI(items[index]))}
                onKeyDown={(e: React.KeyboardEvent) => this.openEnter(e, new URI(items[index]))}>
                <div className='gs-recent-item-content'>
                    <div className='gs-recent-item-info'>
                        <h4 className='gs-recent-item-name'>
                            {this.labelProvider.getName(new URI(items[index]))}
                        </h4>
                        <p className='gs-recent-item-path'>{item}</p>
                    </div>
                    <span className='gs-recent-item-time'>{this.getRelativeTime(items[index])}</span>
                </div>
            </a>
        );

        return <div className='gs-recent-column'>
            <div className='gs-recent-header'>
                <h2 className='gs-recent-title'>{nls.localizeByDefault('Recent')} Projects</h2>
                {items.length > this.recentLimit && (
                    <a
                        className='gs-view-all'
                        role='button'
                        tabIndex={0}
                        onClick={this.doOpenRecentWorkspace}
                        onKeyDown={this.doOpenRecentWorkspaceEnter}>
                        {nls.localizeByDefault('View all')}
                    </a>
                )}
            </div>
            <div className='gs-recent-list'>
                {items.length > 0 ? content : (
                    <div className='gs-no-recent'>
                        <p>
                            {nls.localizeByDefault('You have no recent folders,') + ' '}
                            <a
                                role='button'
                                tabIndex={0}
                                onClick={this.doOpenFolder}
                                onKeyDown={this.doOpenFolderEnter}>
                                {nls.localizeByDefault('open a folder')}
                            </a>
                            {' ' + nls.localizeByDefault('to start.')}
                        </p>
                    </div>
                )}
            </div>
        </div>;
    }


    /**
     * Build the list of workspace paths.
     * @param workspaces {string[]} the list of workspaces.
     * @returns {string[]} the list of workspace paths.
     */
    protected buildPaths(workspaces: string[]): string[] {
        const paths: string[] = [];
        workspaces.forEach(workspace => {
            const uri = new URI(workspace);
            const pathLabel = this.labelProvider.getLongName(uri);
            const path = this.home ? Path.tildify(pathLabel, this.home) : pathLabel;
            paths.push(path);
        });
        return paths;
    }

    /**
     * Get relative time string for a workspace.
     * @param workspace the workspace URI string
     * @returns relative time string like "Yesterday", "2 days ago"
     */
    protected getRelativeTime(workspace: string): string {
        // For now, return a placeholder. In a real implementation,
        // you would track workspace access times and calculate relative time.
        return 'Recently';
    }

    /**
     * Trigger the create file command.
     */
    protected doCreateFile = () => this.commandRegistry.executeCommand(CommonCommands.PICK_NEW_FILE.id);
    protected doCreateFileEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doCreateFile();
        }
    };

    /**
     * Trigger the open command.
     */
    protected doOpen = () => this.commandRegistry.executeCommand(WorkspaceCommands.OPEN.id);
    protected doOpenEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpen();
        }
    };

    /**
     * Trigger the open file command.
     */
    protected doOpenFile = () => this.commandRegistry.executeCommand(WorkspaceCommands.OPEN_FILE.id);
    protected doOpenFileEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpenFile();
        }
    };

    /**
     * Trigger the open folder command.
     */
    protected doOpenFolder = () => this.commandRegistry.executeCommand(WorkspaceCommands.OPEN_FOLDER.id);
    protected doOpenFolderEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpenFolder();
        }
    };

    /**
     * Trigger the open workspace command.
     */
    protected doOpenWorkspace = () => this.commandRegistry.executeCommand(WorkspaceCommands.OPEN_WORKSPACE.id);
    protected doOpenWorkspaceEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpenWorkspace();
        }
    };

    /**
     * Trigger the open recent workspace command.
     */
    protected doOpenRecentWorkspace = () => this.commandRegistry.executeCommand(WorkspaceCommands.OPEN_RECENT_WORKSPACE.id);
    protected doOpenRecentWorkspaceEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpenRecentWorkspace();
        }
    };

    /**
     * Trigger the open preferences command.
     * Used to open the preferences widget.
     */
    protected doOpenPreferences = () => this.commandRegistry.executeCommand(CommonCommands.OPEN_PREFERENCES.id);
    protected doOpenPreferencesEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpenPreferences();
        }
    };


    /**
     * Open a workspace given its uri.
     * @param uri {URI} the workspace uri.
     */
    protected open = (uri: URI) => this.workspaceService.open(uri);
    protected openEnter = (e: React.KeyboardEvent, uri: URI) => {
        if (this.isEnterKey(e)) {
            this.open(uri);
        }
    };


    protected isEnterKey(e: React.KeyboardEvent): boolean {
        return Key.ENTER.keyCode === KeyCode.createKeyCode(e.nativeEvent).key?.keyCode;
    }
}
