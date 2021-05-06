// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import TelemetryReporter from 'vscode-extension-telemetry';
import * as path from 'path';
import * as fs from 'fs';
import { CDPTarget } from './cdpTarget';
import { fixRemoteWebSocket, getListOfTargets, getRemoteEndpointSettings, IRemoteTargetJson, SETTINGS_STORE_NAME } from './utils';
import { IncomingMessage } from 'http';
import https = require('https');
import { setLaunchConfig } from './extension';

export class CDPTargetsProvider implements vscode.TreeDataProvider<CDPTarget> {
    readonly onDidChangeTreeData: vscode.Event<CDPTarget | null>;
    readonly changeDataEvent: vscode.EventEmitter<CDPTarget | null>;
    private extensionPath: string;
    private telemetryReporter: Readonly<TelemetryReporter>;

    constructor(context: vscode.ExtensionContext, telemetryReporter: Readonly<TelemetryReporter>) {
        this.changeDataEvent = new vscode.EventEmitter<CDPTarget | null>();
        this.onDidChangeTreeData = this.changeDataEvent.event;
        this.extensionPath = context.extensionPath;
        this.telemetryReporter = telemetryReporter;
    }

    getTreeItem(element: CDPTarget): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: CDPTarget): Promise<CDPTarget[]> {
        let targets: CDPTarget[] = [];

        const willShowWorkers = vscode.workspace.getConfiguration(SETTINGS_STORE_NAME).get('showWorkers');

        if (!element) {
            // Get a list of the targets available
            const { hostname, port, useHttps } = getRemoteEndpointSettings();
            const responseArray = await getListOfTargets(hostname, port, useHttps);
            if (Array.isArray(responseArray)) {
                this.telemetryReporter.sendTelemetryEvent(
                    'view/list',
                    undefined,
                    { targetCount: responseArray.length },
                );
                if (responseArray.length) {
                    await new Promise<void>(resolve => {
                        let targetsProcessed = 0;
                        // eslint-disable-next-line @typescript-eslint/no-misused-promises
                        responseArray.forEach(async (target: IRemoteTargetJson) => {
                            const actualTarget = fixRemoteWebSocket(hostname, port, target);
                            if (actualTarget.type === 'page' || actualTarget.type === 'iframe') {
                                const iconPath = await this.downloadFaviconFromSitePromise(actualTarget.url);
                                if (iconPath) {
                                    targets.push(new CDPTarget(actualTarget, '', this.extensionPath, iconPath));
                                } else {
                                    targets.push(new CDPTarget(actualTarget, '', this.extensionPath));
                                }
                            } else if ((actualTarget.type !== 'service_worker' && actualTarget.type !== 'shared_worker') || willShowWorkers) {
                                targets.push(new CDPTarget(actualTarget, '', this.extensionPath));
                            }
                            targetsProcessed++;
                            if (targetsProcessed === responseArray.length) {
                                resolve();
                            }
                        });
                    });
                }
            } else {
                this.telemetryReporter.sendTelemetryEvent('view/error/no_json_array');
            }
            // Sort the targets by type and then title, but keep 'page' types at the top
            // since those are the ones most likely to be the ones the user wants.
            targets.sort((a: CDPTarget, b: CDPTarget) => {
                if (a.targetJson.type === b.targetJson.type) {
                    return a.targetJson.title < b.targetJson.title ? -1 : 1;
                } if (a.targetJson.type === 'page') {
                    return -1;
                } if (b.targetJson.type === 'page') {
                    return 1;
                }
                    return a.targetJson.type < b.targetJson.type ? -1 : 1;

            });
        } else {
            // Just expand the element to show its properties
            targets = element.getChildren();
        }

        return targets;
    }

    refresh(): void {
        this.telemetryReporter.sendTelemetryEvent('view/refresh');
        this.changeDataEvent.fire(null);
        void this.clearFaviconResourceDirectory();
        setLaunchConfig();
    }

    async clearFaviconResourceDirectory(): Promise<void> {
        const directory = path.join(this.extensionPath, 'resources', 'favicons');
        const files = await fs.promises.readdir(directory);
        for (const file of files) {
            const fileString = file.toString();
            if (fileString !== '.gitkeep') {
                await fs.promises.unlink(path.join(directory, fileString));
            }
        }
    }

    downloadFaviconFromSitePromise(url: string) : Promise<string | null> | null {
        if (!url || !url.startsWith('https')) {
            return null;
        }
        const faviconRegex = /((?:\/\/|\.)([^\.]*)\.[^\.^\/]+\/).*/;

        // Example regex match: https://docs.microsoft.com/en-us/microsoft-edge/
        // urlMatch[0] = .microsoft.com/en-us/microsoft-edge/
        // urlMatch[1] = .microsoft.com/
        // urlMatch[2] = microsoft
        const urlMatch = faviconRegex.exec(url);
        let filename;
        if (urlMatch) {
            filename = `${urlMatch[2]}Favicon.ico`;
        } else {
            return null;
        }

        // Replacing ".microsoft.com/en-us/microsoft-edge/" with ".microsoft.com/favicon.ico"
        const faviconUrl = url.replace(faviconRegex, '$1favicon.ico');

        const filePath = path.join(this.extensionPath, 'resources', 'favicons', filename);

        const file = fs.createWriteStream(filePath);
        const promise = new Promise<string | null>(resolve => {

            https.get(faviconUrl, (response: IncomingMessage) => {
                if (response.headers['content-type'] && response.headers['content-type'].includes('icon')) {
                    response.pipe(file);
                    file.on('error', () => {
                        resolve(null);
                    });
                    file.on('finish', () => {
                        if (file.bytesWritten) {
                            resolve(filePath);
                        } else {
                            resolve(null);
                        }
                    });
                } else {
                    resolve(null);
                }
            });
        });

        const timeout = new Promise<null>(resolve => {
            const id = setTimeout(() => {
                clearTimeout(id);
                resolve(null);
            }, 1000);
        });

        // If it takes over a second to download, we will resolve null and use default icons.
        return Promise.race([promise, timeout]);
    }
}
