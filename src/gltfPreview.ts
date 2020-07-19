import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ContextBase } from './contextBase';
import { parseJsonMap } from './utilities';
import { GLTF2 } from './GLTF2';

export interface GltfPreviewPanel extends vscode.WebviewPanel {
    readonly textEditor: vscode.TextEditor;
    readonly ready: boolean;
}

interface GltfPreviewPanelInfo extends GltfPreviewPanel {
    textEditor: vscode.TextEditor;
    ready: boolean;

    _jsonMap: { data: GLTF2.GLTF, pointers: any };
    _defaultBabylonReflection: string;
    _defaultThreeReflection: string;

    _watchers: Array<fs.FSWatcher>;
}

export class GltfPreview extends ContextBase {
    private readonly _mainHtml: string;
    private readonly _babylonHtml: string;
    private readonly _cesiumHtml: string;
    private readonly _threeHtml: string;

    private _panels: { [fileName: string]: GltfPreviewPanelInfo } = {};

    private _activePanel: GltfPreviewPanel;
    private _onDidChangeActivePanel: vscode.EventEmitter<GltfPreviewPanel | undefined> = new vscode.EventEmitter<GltfPreviewPanel | undefined>();
    private _onDidChangePanelReady: vscode.EventEmitter<GltfPreviewPanel> = new vscode.EventEmitter<GltfPreviewPanel>();

    constructor(context: vscode.ExtensionContext) {
        super(context);

        this._mainHtml = fs.readFileSync(this._context.asAbsolutePath('pages/previewModel.html'), 'utf-8');
        this._babylonHtml = encodeURI(fs.readFileSync(this._context.asAbsolutePath('pages/babylonView.html'), 'utf-8'));
        this._cesiumHtml = encodeURI(fs.readFileSync(this._context.asAbsolutePath('pages/cesiumView.html'), 'utf-8'));
        this._threeHtml = encodeURI(fs.readFileSync(this._context.asAbsolutePath('pages/threeView.html'), 'utf-8'));
    }

    // Instructions to open DevTools on the glTF preview window:
    //
    // 1. Open the glTF preview window.
    //
    // 2. Press F1 to open the command bar at the top of VSCode.
    //
    // 3. Type in and run the following command:
    //    Developer: Open Webview Developer Tools
    //
    // 4. In the top of the Console tab of DevTools, click the pull-down
    //    and change `top` to `active-frame (index.html)`.

    public openPanel(gltfEditor: vscode.TextEditor): void {
        const gltfFilePath = gltfEditor.document.fileName;

        let panel = this._panels[gltfFilePath];
        if (!panel) {
            const localResourceRoots = [
                vscode.Uri.file(this._context.extensionPath),
                vscode.Uri.file(path.dirname(gltfFilePath)),
            ];

            const defaultBabylonReflection = this.getConfigResourceUrl('glTF.Babylon', 'environment', localResourceRoots);
            const defaultThreeReflection = this.getConfigResourceUrl('glTF.Three', 'environment', localResourceRoots);

            panel = vscode.window.createWebviewPanel('gltf.preview', 'glTF Preview', vscode.ViewColumn.Two, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: localResourceRoots,
            }) as GltfPreviewPanelInfo;

            panel._defaultBabylonReflection = defaultBabylonReflection;
            panel._defaultThreeReflection = defaultThreeReflection;

            panel._watchers = [];

            panel.textEditor = gltfEditor;

            panel.onDidDispose(() => {
                this.unwatchFiles(this._panels[gltfFilePath]);
                delete this._panels[gltfFilePath];
                this.updateActivePanel();
            });

            panel.onDidChangeViewState(() => {
                this.updateActivePanel();
            });

            this._panels[gltfFilePath] = panel;
        }

        const gltfContent = gltfEditor.document.getText();
        this.updatePanel(panel, gltfFilePath, gltfContent);
        panel.reveal(vscode.ViewColumn.Two);

        this.setActivePanel(panel);
    }

    public get activePanel(): GltfPreviewPanel | undefined {
        return this._activePanel;
    }

    public readonly onDidChangeActivePanel = this._onDidChangeActivePanel.event;

    public getPanel(fileName: string): GltfPreviewPanel | undefined {
        return this._panels[fileName];
    }

    public readonly onDidChangeReadyState = this._onDidChangePanelReady.event;

    private setActivePanel(activePanel: GltfPreviewPanel | undefined): void {
        if (this._activePanel !== activePanel) {
            this._activePanel = activePanel;
            this._onDidChangeActivePanel.fire(activePanel);

            if (activePanel) {
                activePanel.webview.postMessage({ command: 'updateDebugMode' });
            }
            else {
                vscode.commands.executeCommand('setContext', 'gltfDebugActive', false);
            }
        }
    }

    private updateActivePanel(): void {
        const activePanel = Object.values(this._panels).find(panel => panel.active);
        this.setActivePanel(activePanel);
    }

    private updatePanel(panel: GltfPreviewPanelInfo, gltfFilePath: string, gltfContent: string): void {
        const map = parseJsonMap(gltfContent);
        panel._jsonMap = map;

        const gltfRootPath = `${path.dirname(gltfFilePath)}/`;
        const gltfFileName = path.basename(gltfFilePath);

        const gltf = map.data;
        let gltfMajorVersion = 1;
        if (gltf && gltf.asset && gltf.asset.version && gltf.asset.version[0] === '2') {
            gltfMajorVersion = 2;
        }

        panel.title = `glTF Preview [${gltfFileName}]`;
        panel.webview.html = this.formatHtml(
            panel,
            gltfMajorVersion,
            gltfContent,
            gltfRootPath,
            gltfFileName,
            panel._defaultBabylonReflection,
            panel._defaultThreeReflection)
            .replace(/\${webview.cspSource}/g, panel.webview.cspSource);

        panel.webview.onDidReceiveMessage(message => {
            this.onDidReceiveMessage(panel, message);
        });

        this.watchFiles(panel);
    }

    private onDidReceiveMessage(panel: GltfPreviewPanelInfo, message: any): void {
        switch (message.command) {
            case 'select': {
                const pointer = panel._jsonMap.pointers[message.jsonPointer];
                const document = panel.textEditor.document;
                const range = new vscode.Range(document.positionAt(pointer.value.pos), document.positionAt(pointer.valueEnd.pos));
                vscode.commands.executeCommand('gltf.openGltfSelection', range);
                break;
            }
            case 'setContext': {
                vscode.commands.executeCommand('setContext', message.name, message.value);
                break;
            }
            case 'showErrorMessage': {
                vscode.window.showErrorMessage(message.message);
                break;
            }
            case 'showWarningMessage': {
                vscode.window.showWarningMessage(message.message);
                break;
            }
            case 'onReady': {
                panel.ready = true;
                this._onDidChangePanelReady.fire(panel);
                break;
            }
            default: {
                throw new Error(`Unknown command: ${message.command}`);
            }
        }
    }

    private formatHtml(panel: GltfPreviewPanelInfo, gltfMajorVersion: number, gltfContent: string, gltfRootPath: string,
            gltfFileName: string, defaultBabylonReflection: string, defaultThreeReflection: string): string {
        const defaultEngine = vscode.workspace.getConfiguration('glTF').get('defaultV' + gltfMajorVersion + 'Engine');

        const dracoLoaderPath = this.extensionRootPath + 'engines/Draco/draco_decoder.js';
        const dracoLoaderWasmPath = this.extensionRootPath + 'engines/Draco/draco_decoder.wasm';

        // These strings are available in JavaScript by looking up the ID.  They provide the extension's root
        // path (needed for locating additional assets), various settings, and the glTF name and contents.
        // Some engines can display "live" glTF contents, others must load from the glTF path and filename.
        // The path name is needed for glTF files that include external resources.
        const strings = [
            { id: 'extensionRootPath', text: this.extensionRootPath },
            { id: 'defaultEngine', text: defaultEngine },
            { id: 'defaultBabylonReflection', text: defaultBabylonReflection },
            { id: 'defaultThreeReflection', text: defaultThreeReflection },
            { id: 'dracoLoaderPath', text: dracoLoaderPath },
            { id: 'dracoLoaderWasmPath', text: dracoLoaderWasmPath },
            { id: 'babylonHtml', text: this._babylonHtml },
            { id: 'cesiumHtml', text: this._cesiumHtml },
            { id: 'threeHtml', text: this._threeHtml },
            { id: 'gltf', text: gltfContent },
            { id: 'gltfRootPath', text: gltfRootPath },
            { id: 'gltfFileName', text: gltfFileName }
        ];

        const styles = [
            'pages/babylonView.css',
            'pages/cesiumView.css',
            'pages/threeView.css',
            'pages/previewModel.css'
        ].map(s => panel.webview.asWebviewUri(vscode.Uri.file(path.join(this.extensionRootPath, s))));

        const scripts = [
            'engines/Cesium/Cesium.js',
            'node_modules/babylonjs/babylon.js',
            'node_modules/babylonjs-loaders/babylonjs.loaders.min.js',
            'node_modules/babylonjs-inspector/babylon.inspector.bundle.js',
            'engines/Three/three.min.js',
            'engines/Three/DDSLoader.js',
            'engines/Three/DRACOLoader.js',
            'engines/Three/GLTFLoader.js',
            'engines/Three/OrbitControls.js',
            'pages/babylonView.js',
            'pages/babylonDebug.js',
            'pages/cesiumView.js',
            'pages/threeView.js',
            'pages/previewModel.js'
        ].map(s => panel.webview.asWebviewUri(vscode.Uri.file(path.join(this.extensionRootPath, s))));

        // Note that with the file: protocol, we must manually specify the UTF-8 charset.
        return this._mainHtml.replace('{assets}',
            styles.map(s => `<link rel="stylesheet" href="${s}"></link>\n`).join('') +
            strings.map(s => `<script id="${s.id}" type="text/plain">${s.text}</script>\n`).join('') +
            scripts.map(s => `<script type="text/javascript" charset="UTF-8" crossorigin="anonymous" src="${s}"></script>\n`).join(''));
    }

    private watchFiles(panel: GltfPreviewPanelInfo): void {
        this.unwatchFiles(panel);

        const document = panel.textEditor.document;
        const documentFilePath = document.fileName;
        panel._watchers.push(fs.watch(documentFilePath, () => {
            this.updatePanel(panel, documentFilePath, document.getText());
        }));

        const documentDirectoryPath = path.dirname(documentFilePath);

        const watch = (object: Object) => {
            for (const key in object) {
                if (object.hasOwnProperty(key)) {
                    const value = object[key];
                    if (key === "uri" && typeof value === "string" && !value.startsWith("data:")) {
                        const filePath = path.join(documentDirectoryPath, value);
                        panel._watchers.push(fs.watch(filePath, () => {
                            panel.webview.postMessage({ command: 'refresh' });
                        }));
                    }
                    else if (typeof value === "object") {
                        watch(value);
                    }
                }
            }
        };

        watch(panel._jsonMap.data);
    }

    private unwatchFiles(panel: GltfPreviewPanelInfo) {
        for (const watcher of panel._watchers) {
            watcher.close();
        }

        panel._watchers.length = 0;
    }
}
