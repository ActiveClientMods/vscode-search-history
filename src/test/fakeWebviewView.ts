// A stand-in for `vscode.WebviewView` so the search bar can be driven end to end
// from tests: send it the messages the real client script sends, and read back
// the messages it posts. Without this the entire search → render → replace path
// would only ever be exercised by hand.

import * as vscode from 'vscode';

export class FakeWebviewView {
	readonly viewType = 'searchHistory.searchBar';
	visible = true;
	title?: string;
	description?: string;
	badge?: vscode.ViewBadge;

	/** Everything the provider has posted to the webview, in order. */
	readonly posted: any[] = [];

	private readonly disposeEmitter = new vscode.EventEmitter<void>();
	private readonly visibilityEmitter = new vscode.EventEmitter<void>();
	private readonly inbound = new vscode.EventEmitter<any>();
	private readonly outbound = new vscode.EventEmitter<any>();

	readonly onDidDispose = this.disposeEmitter.event;
	readonly onDidChangeVisibility = this.visibilityEmitter.event;

	readonly webview = {
		options: {} as vscode.WebviewOptions,
		html: '',
		cspSource: 'vscode-webview://fake',
		onDidReceiveMessage: (listener: (message: any) => void) => this.inbound.event(listener),
		postMessage: (message: any) => {
			this.posted.push(message);
			this.outbound.fire(message);
			return Promise.resolve(true);
		},
		asWebviewUri: (uri: vscode.Uri) => uri,
	};

	show(): void {
		/* the real view would take focus; nothing to do here */
	}

	/** Deliver a message as if the client script had posted it. */
	send(message: unknown): void {
		this.inbound.fire(message);
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.visibilityEmitter.fire();
	}

	/** Resolve once the provider posts a message of the given type. */
	nextMessage(type: string, timeoutMs = 20000): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				subscription.dispose();
				reject(new Error(`timed out waiting for a "${type}" message`));
			}, timeoutMs);
			const subscription = this.outbound.event((message) => {
				if (message?.type === type) {
					clearTimeout(timer);
					subscription.dispose();
					resolve(message);
				}
			});
		});
	}

	/** All posted messages of a type, oldest first. */
	messages(type: string): any[] {
		return this.posted.filter((m) => m?.type === type);
	}

	clearPosted(): void {
		this.posted.length = 0;
	}

	asWebviewView(): vscode.WebviewView {
		return this as unknown as vscode.WebviewView;
	}
}
